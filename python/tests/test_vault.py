"""Tests for the encrypted credential vault."""

import pytest

from betterwright.vault import (
    CredentialNotFoundError,
    CredentialVault,
    InvalidOriginError,
    normalize_http_origin,
)


@pytest.fixture
def vault(tmp_path):
    return CredentialVault(tmp_path / "vault")


def test_origin_normalization():
    assert normalize_http_origin("https://Example.com:443/path") == "https://example.com"
    assert normalize_http_origin("http://example.com:80") == "http://example.com"
    assert normalize_http_origin("https://example.com:8443") == "https://example.com:8443"


def test_origin_rejects_userinfo():
    with pytest.raises(InvalidOriginError):
        normalize_http_origin("https://user:pass@example.com")


def test_save_returns_no_secret(vault):
    summary = vault.save("https://example.com", "alice", "hunter2-longer-secret")
    assert summary["username"] == "alice"
    assert "password" not in summary
    assert "secret" not in summary


def test_fill_returns_secret_only_to_bridge(vault):
    vault.save("https://example.com", "alice", "hunter2-longer-secret")
    filled = vault.fetch_for_fill("https://example.com", username="alice")
    assert filled["secret"] == "hunter2-longer-secret"


def test_list_is_origin_scoped(vault):
    vault.save("https://a.example.com", "a", "password-a-longer")
    vault.save("https://b.example.com", "b", "password-b-longer")
    listed = vault.list_credentials("https://a.example.com")
    assert [row["username"] for row in listed] == ["a"]


def test_missing_credential_raises(vault):
    with pytest.raises(CredentialNotFoundError):
        vault.fetch_for_fill("https://nope.example.com")


def test_encrypted_at_rest(vault, tmp_path):
    vault.save("https://example.com", "alice", "super-secret-passphrase")
    blob = (tmp_path / "vault" / "credentials.enc").read_bytes()
    assert b"super-secret-passphrase" not in blob
    assert b"alice" not in blob


def test_redaction_scrubs_seen_secret(vault):
    vault.save("https://example.com", "alice", "top-secret-value-xyz")
    vault.fetch_for_fill("https://example.com", username="alice")
    scrubbed = vault.redact({"leak": "the password is top-secret-value-xyz here"})
    assert "top-secret-value-xyz" not in scrubbed["leak"]
    assert "[REDACTED]" in scrubbed["leak"]


def test_generate_password_strength():
    password = CredentialVault.generate_secure_password(24)
    assert len(password) == 24
    assert any(c.islower() for c in password)
    assert any(c.isupper() for c in password)
    assert any(c.isdigit() for c in password)


def test_reopen_persists_records(tmp_path):
    root = tmp_path / "vault"
    CredentialVault(root).save("https://example.com", "alice", "durable-secret-value")
    reopened = CredentialVault(root)
    assert reopened.list_credentials("https://example.com")[0]["username"] == "alice"
