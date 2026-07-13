"""Encrypted, origin-scoped credentials for the native Playwright runtime.

The vault intentionally lives outside Chromium's user-data directory.  Records
are encrypted as one authenticated AES-256-GCM payload and rewritten atomically;
the audit log contains only an action, normalized origin, and opaque record ID.

The encryption key is stored beside the ciphertext with owner-only permissions.
That protects credentials from accidental disclosure (logs, support bundles,
casual file reads, and plaintext backups), but it is not a defense against an
attacker who can read files as the same OS user.  A platform keychain can be
added later without changing the bridge-facing API below.
"""

from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import os
import secrets
import tempfile
import threading
from collections.abc import Mapping
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from betterwright._home import betterwright_home

try:  # POSIX
    import fcntl
except ImportError:  # pragma: no cover - exercised on Windows
    fcntl = None  # type: ignore[assignment]

try:  # Windows
    import msvcrt
except ImportError:  # pragma: no cover - exercised on POSIX
    msvcrt = None  # type: ignore[assignment]


_AAD = b"betterwright-credential-vault:v1"
_FORMAT_VERSION = 1
_MAX_VAULT_BYTES = 16 * 1024 * 1024
_UNSET = object()
_REDACTED = "[REDACTED]"


class VaultError(RuntimeError):
    """Base error for browser credential operations."""


class InvalidOriginError(VaultError, ValueError):
    """Raised when a credential request is not scoped to an HTTP(S) origin."""


class InvalidCredentialError(VaultError, ValueError):
    """Raised when credential metadata is invalid."""


class CredentialNotFoundError(VaultError, LookupError):
    """Raised when no record matches the requested origin and selector."""


class VaultCorruptedError(VaultError):
    """Raised when encrypted vault data cannot be authenticated or decoded."""


class VaultStorageError(VaultError):
    """Raised when durable vault or audit storage fails."""


def normalize_http_origin(value: str) -> str:
    """Return the canonical HTTP(S) origin for a URL or origin string.

    Paths, query strings, and fragments are deliberately discarded.  Default
    ports are omitted so that the result matches browser ``location.origin``.
    User-info is rejected because it may contain a credential and has no place
    in an origin-scoping key.
    """

    if not isinstance(value, str) or not value.strip():
        raise InvalidOriginError("A non-empty HTTP(S) URL is required.")
    if value != value.strip():
        raise InvalidOriginError(
            "The browser origin must not contain surrounding whitespace."
        )

    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise InvalidOriginError(
            "The browser origin is not a valid URL."
        ) from exc

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise InvalidOriginError(
            "Browser credentials can only be scoped to HTTP(S) origins."
        )
    if parsed.username is not None or parsed.password is not None:
        raise InvalidOriginError(
            "Browser credential origins must not include URL user-info."
        )

    hostname = parsed.hostname
    if not hostname:
        raise InvalidOriginError("The browser origin must include a hostname.")
    if any(char.isspace() or ord(char) < 0x20 for char in hostname):
        raise InvalidOriginError(
            "The browser origin contains an invalid hostname."
        )

    try:
        port = parsed.port
    except ValueError as exc:
        raise InvalidOriginError(
            "The browser origin contains an invalid port."
        ) from exc

    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        try:
            normalized_host = hostname.encode("idna").decode("ascii").lower()
        except (UnicodeError, ValueError) as exc:
            raise InvalidOriginError(
                "The browser origin contains an invalid hostname."
            ) from exc
        if not normalized_host or any(char in normalized_host for char in "/?#@%"):
            raise InvalidOriginError(  # noqa: B904 - not an error in handling idna
                "The browser origin contains an invalid hostname."
            )
    else:
        normalized_host = address.compressed.lower()
        if address.version == 6:
            normalized_host = f"[{normalized_host}]"

    default_port = 80 if scheme == "http" else 443
    port_suffix = "" if port is None or port == default_port else f":{port}"
    return f"{scheme}://{normalized_host}{port_suffix}"


class CredentialVault:
    """Thread-safe encrypted password vault used by the Playwright bridge.

    ``handle_request`` is the stable RPC-facing surface.  Results from
    ``generate``, ``fill``, and ``reveal`` contain an internal ``secret`` key;
    callers must consume it inside the bridge and remove it before returning a
    model-visible result.  ``redact`` can scrub arbitrary nested output as a
    final fail-safe.
    """

    _locks_guard: ClassVar[threading.Lock] = threading.Lock()
    _locks_by_root: ClassVar[dict[str, threading.RLock]] = {}

    def __init__(self, root: str | Path | None = None) -> None:
        if root is None:
            home = betterwright_home()
            managed_dirs = (home, home / "vault")
            self.root = managed_dirs[-1]
        else:
            self.root = Path(root)
            managed_dirs = (self.root,)

        root_key = os.path.abspath(os.fspath(self.root))
        with self._locks_guard:
            self._lock = self._locks_by_root.setdefault(root_key, threading.RLock())

        self.key_path = self.root / "vault.key"
        self.data_path = self.root / "credentials.enc"
        self.audit_path = self.root / "audit.jsonl"
        self.lock_path = self.root / ".vault.lock"
        self._active_secrets: set[str] = set()

        with self._lock:
            try:
                for directory in managed_dirs:
                    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
                    self._chmod_best_effort(directory, 0o700)
            except OSError as exc:
                raise VaultStorageError(
                    f"Could not create the browser password vault directory: {self.root}"
                ) from exc

    @contextmanager
    def _exclusive(self):
        """Hold both the in-process and cross-process vault locks.

        Desktop, gateway, and CLI processes intentionally share one browser
        identity.  The complete encrypted read/modify/write plus audit append
        therefore has to be one transaction across processes, not merely
        across threads in one Python interpreter.
        """

        with self._lock:
            try:
                handle = self.lock_path.open("a+b")
                self._chmod_best_effort(self.lock_path, 0o600)
            except OSError as exc:
                raise VaultStorageError(
                    "Could not open the browser vault process lock."
                ) from exc
            try:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                elif msvcrt is not None:  # pragma: no cover - Windows only
                    handle.seek(0, os.SEEK_END)
                    if handle.tell() == 0:
                        handle.write(b"\0")
                        handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                yield
            finally:
                try:
                    if fcntl is not None:
                        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                    elif msvcrt is not None:  # pragma: no cover - Windows only
                        handle.seek(0)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                finally:
                    handle.close()

    @staticmethod
    def _chmod_best_effort(path: Path, mode: int) -> None:
        try:
            os.chmod(path, mode)
        except OSError:
            # Windows and some network filesystems cannot represent POSIX modes.
            pass

    @staticmethod
    def _validate_text(
        value: object,
        field_name: str,
        *,
        allow_empty: bool,
        max_length: int,
    ) -> str:
        if not isinstance(value, str):
            raise InvalidCredentialError(
                f"Credential {field_name} must be text."
            )
        if not allow_empty and not value:
            raise InvalidCredentialError(
                f"Credential {field_name} must not be empty."
            )
        if len(value) > max_length:
            raise InvalidCredentialError(f"Credential {field_name} is too long.")
        return value

    @classmethod
    def _validate_record_id(cls, record_id: object) -> str:
        result = cls._validate_text(
            record_id,
            "record id",
            allow_empty=False,
            max_length=128,
        )
        if any(ord(char) < 0x20 for char in result):
            raise InvalidCredentialError(
                "Credential record id contains invalid characters."
            )
        return result

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    def _load_key(self, *, create: bool) -> bytes:
        if self.key_path.exists():
            try:
                key = self.key_path.read_bytes()
            except OSError as exc:
                raise VaultStorageError(
                    "Could not read the browser vault key."
                ) from exc
            if len(key) != 32:
                raise VaultCorruptedError(
                    "The vault key is invalid; restore the matching 32-byte key "
                    "or reset the vault."
                )
            self._chmod_best_effort(self.key_path, 0o600)
            return key

        if not create:
            raise VaultCorruptedError(
                "The encrypted browser password vault exists, but its key is missing."
            )

        key = AESGCM.generate_key(bit_length=256)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        try:
            fd = os.open(self.key_path, flags, 0o600)
        except FileExistsError:
            # Another thread/process won the create race.  Read its key rather
            # than overwriting it and orphaning any ciphertext it produced.
            return self._load_key(create=False)
        except OSError as exc:
            raise VaultStorageError(
                "Could not create the browser vault key."
            ) from exc

        try:
            with os.fdopen(fd, "wb") as handle:
                if hasattr(os, "fchmod"):
                    os.fchmod(handle.fileno(), 0o600)
                handle.write(key)
                handle.flush()
                os.fsync(handle.fileno())
            self._chmod_best_effort(self.key_path, 0o600)
        except BaseException:
            try:
                self.key_path.unlink()
            except OSError:
                pass
            raise
        return key

    def _atomic_write_bytes(self, path: Path, data: bytes) -> None:
        fd, temporary_name = tempfile.mkstemp(
            dir=str(path.parent),
            prefix=f".{path.name}.",
            suffix=".tmp",
        )
        temporary = Path(temporary_name)
        try:
            if hasattr(os, "fchmod"):
                os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            self._chmod_best_effort(path, 0o600)
            try:
                directory_fd = os.open(path.parent, os.O_RDONLY)
            except OSError:
                directory_fd = None
            if directory_fd is not None:
                try:
                    os.fsync(directory_fd)
                except OSError:
                    pass
                finally:
                    os.close(directory_fd)
        except BaseException:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                temporary.unlink()
            except OSError:
                pass
            raise

    def _load_records(self) -> dict[str, dict[str, Any]]:
        if not self.data_path.exists():
            return {}
        try:
            if self.data_path.stat().st_size > _MAX_VAULT_BYTES:
                raise VaultCorruptedError(
                    "The encrypted browser password vault exceeds the supported size limit."
                )
            envelope = json.loads(self.data_path.read_text(encoding="utf-8"))
            if (
                not isinstance(envelope, dict)
                or envelope.get("version") != _FORMAT_VERSION
            ):
                raise VaultCorruptedError(
                    "The encrypted browser password vault uses an unsupported format."
                )
            nonce = base64.b64decode(envelope["nonce"], validate=True)
            ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
            if len(nonce) != 12:
                raise VaultCorruptedError(
                    "The encrypted browser password vault has an invalid nonce."
                )
            plaintext = AESGCM(self._load_key(create=False)).decrypt(
                nonce, ciphertext, _AAD
            )
            payload = json.loads(plaintext.decode("utf-8"))
        except VaultError:
            raise
        except (
            InvalidTag,
            binascii.Error,
            UnicodeDecodeError,
            ValueError,
            TypeError,
            KeyError,
            json.JSONDecodeError,
        ) as exc:
            raise VaultCorruptedError(
                "The browser password vault could not be authenticated or decoded."
            ) from exc
        except OSError as exc:
            raise VaultStorageError(
                "Could not read the browser password vault."
            ) from exc

        if not isinstance(payload, dict) or payload.get("version") != _FORMAT_VERSION:
            raise VaultCorruptedError(
                "The decrypted browser password vault uses an unsupported format."
            )
        records = payload.get("records")
        if not isinstance(records, dict):
            raise VaultCorruptedError(
                "The decrypted browser password vault has an invalid record table."
            )
        for record_id, record in records.items():
            if not isinstance(record_id, str) or not isinstance(record, dict):
                raise VaultCorruptedError(
                    "The decrypted browser password vault contains an invalid record."
                )
            required = (
                "id",
                "origin",
                "username",
                "password",
                "created_at",
                "updated_at",
            )
            if record.get("id") != record_id or any(
                not isinstance(record.get(key), str) for key in required
            ):
                raise VaultCorruptedError(
                    "The decrypted browser password vault contains an invalid record."
                )
            try:
                if normalize_http_origin(record["origin"]) != record["origin"]:
                    raise InvalidOriginError("non-canonical")
            except InvalidOriginError as exc:
                raise VaultCorruptedError(
                    "The decrypted browser password vault contains an invalid origin."
                ) from exc
            if record.get("label") is not None and not isinstance(
                record.get("label"), str
            ):
                raise VaultCorruptedError(
                    "The decrypted browser password vault contains an invalid label."
                )
        return records

    def _save_records(self, records: dict[str, dict[str, Any]]) -> None:
        payload = json.dumps(
            {"version": _FORMAT_VERSION, "records": records},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(self._load_key(create=True)).encrypt(nonce, payload, _AAD)
        envelope = json.dumps(
            {
                "version": _FORMAT_VERSION,
                "algorithm": "AES-256-GCM",
                "nonce": base64.b64encode(nonce).decode("ascii"),
                "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode("ascii")
        try:
            self._atomic_write_bytes(self.data_path, envelope)
        except OSError as exc:
            raise VaultStorageError(
                "Could not atomically write the encrypted browser password vault."
            ) from exc

    def _append_audit(self, action: str, origin: str, record_id: str | None) -> None:
        event = (
            json.dumps(
                {
                    "timestamp": self._now(),
                    "action": action,
                    "origin": origin,
                    "record_id": record_id,
                },
                ensure_ascii=True,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
            + b"\n"
        )
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        if hasattr(os, "O_BINARY"):
            flags |= os.O_BINARY
        try:
            fd = os.open(self.audit_path, flags, 0o600)
            try:
                if hasattr(os, "fchmod"):
                    os.fchmod(fd, 0o600)
                os.write(fd, event)
                os.fsync(fd)
            finally:
                os.close(fd)
            self._chmod_best_effort(self.audit_path, 0o600)
        except OSError as exc:
            raise VaultStorageError(
                "Could not append the browser vault audit log."
            ) from exc

    @staticmethod
    def _summary(record: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "id": record["id"],
            "origin": record["origin"],
            "username": record["username"],
            "label": record.get("label"),
            "created_at": record["created_at"],
            "updated_at": record["updated_at"],
        }

    def _remember_secret(self, value: str) -> None:
        if value:
            self._active_secrets.add(value)

    def active_secret_values(self) -> tuple[str, ...]:
        """Return all secrets handled by this instance, longest first."""

        with self._lock:
            return tuple(
                sorted(self._active_secrets, key=lambda item: (-len(item), item))
            )

    def redact_text(self, value: str, replacement: str = _REDACTED) -> str:
        """Replace every active vault secret in text without pattern guessing."""

        if not isinstance(value, str):
            raise TypeError("redact_text expects a string")
        for secret in self.active_secret_values():
            value = value.replace(secret, replacement)
        return value

    def redact(self, value: Any, replacement: str = _REDACTED) -> Any:
        """Recursively redact active vault secrets from a JSON-like value."""

        if isinstance(value, str):
            return self.redact_text(value, replacement)
        if isinstance(value, bytes):
            result = value
            encoded_replacement = replacement.encode("utf-8")
            for secret in self.active_secret_values():
                result = result.replace(secret.encode("utf-8"), encoded_replacement)
            return result
        if isinstance(value, Mapping):
            return {
                self.redact(key, replacement): self.redact(item, replacement)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [self.redact(item, replacement) for item in value]
        if isinstance(value, tuple):
            return tuple(self.redact(item, replacement) for item in value)
        if isinstance(value, set):
            return {self.redact(item, replacement) for item in value}
        return value

    @staticmethod
    def generate_secure_password(
        length: int = 24, *, include_symbols: bool = True
    ) -> str:
        """Generate a password with independent CSPRNG choices and a shuffled mix."""

        if (
            isinstance(length, bool)
            or not isinstance(length, int)
            or not 16 <= length <= 128
        ):
            raise InvalidCredentialError(
                "Generated password length must be between 16 and 128."
            )
        lowercase = "abcdefghijkmnopqrstuvwxyz"
        uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ"
        digits = "23456789"
        symbols = "!@#$%^&*()-_=+"
        required_sets = [lowercase, uppercase, digits]
        if include_symbols:
            required_sets.append(symbols)
        alphabet = "".join(required_sets)
        password = [secrets.choice(characters) for characters in required_sets]
        password.extend(secrets.choice(alphabet) for _ in range(length - len(password)))
        secrets.SystemRandom().shuffle(password)
        return "".join(password)

    def _create(
        self,
        origin: str,
        username: str,
        password: str,
        *,
        label: str | None,
        action: str,
    ) -> dict[str, Any]:
        normalized = normalize_http_origin(origin)
        username = self._validate_text(
            username, "username", allow_empty=True, max_length=4096
        )
        password = self._validate_text(
            password, "password", allow_empty=False, max_length=65_536
        )
        if label is not None:
            label = self._validate_text(
                label, "label", allow_empty=True, max_length=4096
            )
        self._remember_secret(password)

        records = self._load_records()
        record_id = f"cred_{secrets.token_hex(16)}"
        timestamp = self._now()
        record = {
            "id": record_id,
            "origin": normalized,
            "username": username,
            "password": password,
            "label": label,
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        records[record_id] = record
        self._save_records(records)
        self._append_audit(action, normalized, record_id)
        return self._summary(record)

    def save(
        self,
        origin: str,
        username: str,
        password: str,
        *,
        label: str | None = None,
    ) -> dict[str, Any]:
        """Save a supplied password and return only non-secret metadata."""

        with self._exclusive():
            return self._create(origin, username, password, label=label, action="save")

    def generate(
        self,
        origin: str,
        username: str = "",
        *,
        label: str | None = None,
        length: int = 24,
        include_symbols: bool = True,
    ) -> dict[str, Any]:
        """Generate and save a password, returning ``secret`` for bridge use only."""

        with self._exclusive():
            password = self.generate_secure_password(
                length, include_symbols=include_symbols
            )
            result = self._create(
                origin, username, password, label=label, action="generate"
            )
            result["secret"] = password
            return result

    def _matching_record(
        self,
        records: Mapping[str, dict[str, Any]],
        origin: str,
        *,
        record_id: str | None,
        username: str | None = None,
    ) -> dict[str, Any]:
        normalized = normalize_http_origin(origin)
        if record_id is not None:
            record_id = self._validate_record_id(record_id)
            record = records.get(record_id)
            if record is None or record.get("origin") != normalized:
                raise CredentialNotFoundError(
                    "No browser credential matches that record id for the current origin."
                )
            return record

        candidates = [
            record for record in records.values() if record.get("origin") == normalized
        ]
        if username is not None:
            username = self._validate_text(
                username, "username", allow_empty=True, max_length=4096
            )
            candidates = [
                record for record in candidates if record.get("username") == username
            ]
        if not candidates:
            raise CredentialNotFoundError(
                "No browser credential is stored for the current origin."
            )
        return max(candidates, key=lambda record: (record["updated_at"], record["id"]))

    def update(
        self,
        origin: str,
        record_id: str,
        *,
        username: str | object = _UNSET,
        password: str | object = _UNSET,
        label: str | None | object = _UNSET,
    ) -> dict[str, Any]:
        """Update selected fields without ever returning the password."""

        with self._exclusive():
            normalized = normalize_http_origin(origin)
            records = self._load_records()
            record = self._matching_record(records, normalized, record_id=record_id)
            if username is _UNSET and password is _UNSET and label is _UNSET:
                raise InvalidCredentialError(
                    "At least one credential field must be updated."
                )
            if username is not _UNSET:
                record["username"] = self._validate_text(
                    username, "username", allow_empty=True, max_length=4096
                )
            if password is not _UNSET:
                validated_password = self._validate_text(
                    password, "password", allow_empty=False, max_length=65_536
                )
                self._remember_secret(validated_password)
                record["password"] = validated_password
            if label is not _UNSET:
                if label is not None:
                    label = self._validate_text(
                        label, "label", allow_empty=True, max_length=4096
                    )
                record["label"] = label
            record["updated_at"] = self._now()
            self._save_records(records)
            self._append_audit("update", normalized, record["id"])
            return self._summary(record)

    def list_credentials(self, origin: str) -> list[dict[str, Any]]:
        """List non-secret records for exactly one page origin."""

        with self._exclusive():
            normalized = normalize_http_origin(origin)
            records = self._load_records()
            result = [
                self._summary(record)
                for record in records.values()
                if record["origin"] == normalized
            ]
            result.sort(key=lambda item: (item["updated_at"], item["id"]), reverse=True)
            self._append_audit("list", normalized, None)
            return result

    def fetch_for_fill(
        self,
        origin: str,
        *,
        record_id: str | None = None,
        username: str | None = None,
    ) -> dict[str, Any]:
        """Return a secret to the trusted bridge for filling, never for display."""

        with self._exclusive():
            normalized = normalize_http_origin(origin)
            record = self._matching_record(
                self._load_records(),
                normalized,
                record_id=record_id,
                username=username,
            )
            self._remember_secret(record["password"])
            self._append_audit("fill", normalized, record["id"])
            result = self._summary(record)
            result["secret"] = record["password"]
            return result

    def reveal(self, origin: str, record_id: str) -> dict[str, Any]:
        """Explicitly reveal a credential to the trusted bridge and audit it."""

        with self._exclusive():
            normalized = normalize_http_origin(origin)
            record = self._matching_record(
                self._load_records(), normalized, record_id=record_id
            )
            self._remember_secret(record["password"])
            self._append_audit("reveal", normalized, record["id"])
            result = self._summary(record)
            result["secret"] = record["password"]
            return result

    def remove(self, origin: str, record_id: str) -> dict[str, Any]:
        """Remove one record from exactly the supplied origin."""

        with self._exclusive():
            normalized = normalize_http_origin(origin)
            records = self._load_records()
            record = self._matching_record(records, normalized, record_id=record_id)
            del records[record["id"]]
            self._save_records(records)
            self._append_audit("remove", normalized, record["id"])
            return {"id": record["id"], "origin": normalized, "removed": True}

    def handle_request(
        self,
        action: str,
        payload: dict[str, Any] | None,
        origin: str,
    ) -> dict[str, Any]:
        """Dispatch a password-vault RPC request from the Playwright bridge."""

        if not isinstance(action, str):
            raise InvalidCredentialError("Browser vault action must be text.")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise InvalidCredentialError(
                "Browser vault payload must be an object."
            )

        if action == "list":
            return {"credentials": self.list_credentials(origin)}
        if action == "save":
            password = self._validate_text(
                payload.get("password"),
                "password",
                allow_empty=False,
                max_length=65_536,
            )
            return self.save(
                origin,
                payload.get("username", ""),
                password,
                label=payload.get("label"),
            )
        if action == "generate":
            return self.generate(
                origin,
                payload.get("username", ""),
                label=payload.get("label"),
                length=payload.get("length", 24),
                include_symbols=payload.get("include_symbols", True),
            )
        if action == "update":
            updates = {
                key: payload[key]
                for key in ("username", "password", "label")
                if key in payload
            }
            record_id = self._validate_record_id(payload.get("id"))
            return self.update(origin, record_id, **updates)
        if action == "fill":
            return self.fetch_for_fill(
                origin,
                record_id=payload.get("id"),
                username=payload.get("username"),
            )
        if action == "remove":
            record_id = self._validate_record_id(payload.get("id"))
            return self.remove(origin, record_id)
        if action == "reveal":
            record_id = self._validate_record_id(payload.get("id"))
            return self.reveal(origin, record_id)
        raise InvalidCredentialError(
            "Unsupported vault action. Expected list, save, generate, update, "
            "fill, remove, or reveal."
        )


__all__ = [
    "CredentialNotFoundError",
    "CredentialVault",
    "VaultCorruptedError",
    "VaultError",
    "VaultStorageError",
    "InvalidCredentialError",
    "InvalidOriginError",
    "normalize_http_origin",
]
