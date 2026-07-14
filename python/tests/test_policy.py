"""Tests for the network policy — the layer that decides every request."""

from betterwright.policy import NetworkPolicy


def allowed(policy, url, **details):
    return policy.check(url, details).get("allowed", False)


def test_public_https_allowed_by_default():
    assert allowed(NetworkPolicy(), "https://example.com/path?q=1")


def test_metadata_hostname_blocked():
    assert not allowed(NetworkPolicy(), "http://metadata.google.internal/")


def test_metadata_address_blocked():
    assert not allowed(NetworkPolicy(), "http://169.254.169.254/latest/meta-data/")


def test_metadata_cannot_be_allowlisted():
    policy = NetworkPolicy(allow_hosts=("metadata.google.internal",))
    decision = policy.check("http://metadata.google.internal/")
    assert decision["allowed"] is False


def test_private_ranges_blocked_by_default():
    for url in (
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://172.16.9.9/",
        "http://127.0.0.1:8000/",
    ):
        assert not allowed(NetworkPolicy(), url), url


def test_ipv4_mapped_ipv6_preserves_embedded_ipv4_classification():
    for url in (
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:10.0.0.1]/",
        "http://[::ffff:169.254.169.254]/",
    ):
        assert not allowed(NetworkPolicy(), url), url
    assert allowed(NetworkPolicy(), "https://[::ffff:8.8.8.8]/")


def test_loopback_opt_in():
    policy = NetworkPolicy(allow_loopback=True)
    assert allowed(policy, "http://127.0.0.1:3000/")
    assert allowed(policy, "http://localhost:3000/")
    # loopback does not imply the wider private network
    assert not allowed(policy, "http://10.0.0.1/")


def test_private_network_opt_in():
    policy = NetworkPolicy(allow_private_network=True)
    assert allowed(policy, "http://10.0.0.1/")
    assert allowed(policy, "http://localhost/")


def test_block_host_beats_allow_defaults():
    policy = NetworkPolicy(block_hosts=("ads.example.com",))
    assert not allowed(policy, "https://ads.example.com/pixel")
    assert not allowed(policy, "https://tracker.ads.example.com/")
    assert allowed(policy, "https://example.com/")


def test_allow_host_with_port():
    policy = NetworkPolicy(allow_loopback=False, allow_hosts=("localhost:3000",))
    assert allowed(policy, "http://localhost:3000/")
    assert not allowed(policy, "http://localhost:4000/")


def test_secret_bearing_url_blocked():
    policy = NetworkPolicy()
    leak = "https://evil.example.com/?t=ghp_" + "a" * 36
    assert not allowed(policy, leak)


def test_unsupported_scheme_blocked():
    assert not allowed(NetworkPolicy(), "file:///etc/passwd")
    assert not allowed(NetworkPolicy(), "ftp://example.com/")


def test_data_and_blank_allowed():
    assert allowed(NetworkPolicy(), "about:blank")
    assert allowed(NetworkPolicy(), "data:text/html,<p>hi</p>")


def test_custom_hook_overrides():
    def deny_all(url, details):
        return {"allowed": False, "reason": "custom"}

    policy = NetworkPolicy(custom=deny_all)
    assert not allowed(policy, "https://example.com/")
