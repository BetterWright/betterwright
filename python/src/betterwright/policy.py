"""Default network policy for the BetterWright worker.

Every request the browser makes — page navigations, subresources, WebSockets,
and raw TCP connections through the worker's guarded SOCKS transport — is sent
back to the client process as a ``guard`` RPC and answered here. The worker
also re-checks every literal address a hostname resolves to (resource type
``transport-address``), so a policy decision made on a hostname cannot be
bypassed by DNS rebinding: the addresses Chromium ultimately connects to are
each validated by this policy as IP literals.

Two layers sit below this policy and do not depend on it:

* Chromium is launched with ``--host-resolver-rules`` that map cloud metadata
  hostnames and link-local ranges to NXDOMAIN.
* All traffic is forced through the worker's loopback SOCKS proxy
  (``bypass: <-loopback>``), so even localhost requests reach this policy.

The default posture blocks cloud metadata endpoints and private, loopback,
and link-local addresses. Development against local servers is the common
reason to loosen it — use ``allow_hosts`` for one origin, or
``allow_loopback``/``allow_private_network`` for a broader opening.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

GuardDecision = dict[str, Any]

#: Hostnames that resolve to cloud instance-metadata services. These are
#: blocked regardless of ``allow_private_network`` because credentials for the
#: machine's cloud identity are never legitimate browsing targets.
METADATA_HOSTNAMES = frozenset({
    "metadata.google.internal",
    "metadata.goog",
})

#: Literal addresses of instance-metadata services (AWS/GCP/Azure link-local,
#: Alibaba Cloud, AWS ECS task metadata, EC2 IPv6 metadata).
METADATA_ADDRESSES = frozenset({
    "169.254.169.254",
    "169.254.170.2",
    "100.100.100.200",
    "fd00:ec2::254",
})


def _parse_address(hostname: str) -> ipaddress._BaseAddress | None:
    candidate = hostname.strip("[]")
    try:
        return ipaddress.ip_address(candidate)
    except ValueError:
        return None


def _address_category(address: ipaddress._BaseAddress) -> str:
    """Classify an IP literal as ``metadata``, ``loopback``, ``private``, or ``public``."""

    if str(address) in METADATA_ADDRESSES or address in ipaddress.ip_network(
        "fd00:ec2::/32"
    ):
        return "metadata"
    if address.is_loopback:
        return "loopback"
    if (
        address.is_private
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
    ):
        return "private"
    # Carrier-grade NAT is not covered by ``is_private`` on all Python
    # versions; treat it as private explicitly.
    if address.version == 4 and address in ipaddress.ip_network("100.64.0.0/10"):
        return "private"
    return "public"


def _looks_like_secret(url: str) -> bool:
    """Best-effort detection of API keys or tokens embedded in a URL.

    This exists to stop a compromised page from exfiltrating a credential the
    agent pasted into a URL, not to catch every secret format.
    """

    import re

    pattern = re.compile(
        r"(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}"
        r"|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}"
        r"|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,})"
    )
    return bool(pattern.search(url) or pattern.search(unquote(url)))


@dataclass
class NetworkPolicy:
    """Configurable allow/deny policy evaluated for every browser connection.

    Evaluation order: scheme check, explicit ``block_hosts``, explicit
    ``allow_hosts``, metadata floor, private-network rules, then the optional
    ``custom`` hook. ``allow_hosts`` entries match a hostname exactly or as a
    parent domain (``example.com`` also allows ``sub.example.com``); an entry
    with a port only matches that port. Explicit allows still cannot reach
    metadata endpoints.
    """

    allow_private_network: bool = False
    allow_loopback: bool = False
    allow_hosts: tuple[str, ...] = ()
    block_hosts: tuple[str, ...] = ()
    block_secret_bearing_urls: bool = True
    #: Optional final hook: ``custom(url, details) -> Optional[GuardDecision]``.
    #: Return ``None`` to keep the decision made so far, or a decision dict
    #: (``{"allowed": bool, "reason": str}``) to override it.
    custom: Callable[[str, dict], GuardDecision | None] | None = field(
        default=None, repr=False
    )

    def _host_matches(self, entry: str, hostname: str, port: int | None) -> bool:
        entry = entry.lower().strip()
        if not entry:
            return False
        entry_host, entry_port = entry, None
        if ":" in entry and not entry.startswith("["):
            entry_host, _, port_text = entry.rpartition(":")
            entry_port = int(port_text) if port_text.isdigit() else None
        if entry_port is not None and port != entry_port:
            return False
        entry_host = entry_host.strip("[]")
        hostname = hostname.strip("[]")
        return hostname == entry_host or hostname.endswith("." + entry_host)

    def check(self, url: str, details: dict | None = None) -> GuardDecision:
        """Return ``{"allowed": bool}`` or ``{"allowed": False, "reason": str}``."""

        details = details or {}
        url = str(url or "").strip()
        if not url:
            return {"allowed": False, "reason": "empty URL"}
        try:
            parsed = urlsplit(url)
        except ValueError:
            return {"allowed": False, "reason": "invalid URL"}

        scheme = parsed.scheme.lower()
        if scheme == "about" and url.lower() == "about:blank":
            return {"allowed": True}
        if scheme in {"data", "blob"}:
            return {"allowed": True}
        if scheme not in {"http", "https", "ws", "wss"}:
            return {
                "allowed": False,
                "reason": f"unsupported browser URL scheme: {scheme or '<empty>'}",
            }

        hostname = (parsed.hostname or "").lower()
        if not hostname:
            return {"allowed": False, "reason": "URL has no hostname"}
        try:
            port = parsed.port
        except ValueError:
            return {"allowed": False, "reason": "invalid port"}

        if self.block_secret_bearing_urls and _looks_like_secret(url):
            return {
                "allowed": False,
                "reason": "URL contains what appears to be an API key or token",
            }

        decision = self._check_host(hostname, port)
        if self.custom is not None:
            override = self.custom(url, dict(details))
            if override is not None:
                if override.get("allowed") and self._is_metadata(hostname):
                    return {
                        "allowed": False,
                        "reason": "cloud metadata endpoints cannot be allowed",
                    }
                return override
        return decision

    def _is_metadata(self, hostname: str) -> bool:
        if hostname in METADATA_HOSTNAMES:
            return True
        address = _parse_address(hostname)
        return address is not None and _address_category(address) == "metadata"

    def _check_host(self, hostname: str, port: int | None) -> GuardDecision:
        if self._is_metadata(hostname):
            return {"allowed": False, "reason": "cloud metadata endpoint"}

        for entry in self.block_hosts:
            if self._host_matches(entry, hostname, port):
                return {"allowed": False, "reason": f"host blocked by policy: {entry}"}
        for entry in self.allow_hosts:
            if self._host_matches(entry, hostname, port):
                return {"allowed": True}

        address = _parse_address(hostname)
        if address is not None:
            category = _address_category(address)
            if category == "loopback" and not (
                self.allow_loopback or self.allow_private_network
            ):
                return {
                    "allowed": False,
                    "reason": "loopback address (set allow_loopback for local dev)",
                }
            if category == "private" and not self.allow_private_network:
                return {"allowed": False, "reason": "private or internal address"}
            return {"allowed": True}

        if hostname == "localhost" or hostname.endswith(".localhost"):
            if self.allow_loopback or self.allow_private_network:
                return {"allowed": True}
            return {
                "allowed": False,
                "reason": "loopback address (set allow_loopback for local dev)",
            }
        if "." not in hostname or hostname.endswith((".local", ".internal", ".lan")):
            if not self.allow_private_network:
                return {"allowed": False, "reason": "private or internal hostname"}
        return {"allowed": True}


__all__ = [
    "GuardDecision",
    "METADATA_ADDRESSES",
    "METADATA_HOSTNAMES",
    "NetworkPolicy",
]
