"""Store a credential and fill it into a login form — safely.

The password is written to the encrypted vault up front, then filled into the
page by the trusted worker via ``bw.fill_credential(...)``. It is never returned
to this script, never placed in a model-authored ``run()`` snippet, and (as a
final net) is redacted from any run output. Point it at a real login form to see
it work end to end.

    python examples/python/login_with_vault.py
"""

from betterwright import BetterWright

LOGIN_URL = "https://practicetestautomation.com/practice-test-login/"


def main() -> None:
    with BetterWright() as bw:
        bw.run(f"await page.goto({LOGIN_URL!r})", note="Opening the login page")

        # Seed the vault once, scoped to this page's origin. Returns metadata
        # only — never the password.
        saved = bw.vault.save(
            "https://practicetestautomation.com", "student", "Password123"
        )
        print("Stored credential:", saved["id"])

        # Fill username + password from trusted host code and submit in the same
        # call, so no step ever exposes the secret. Only metadata comes back.
        filled = bw.fill_credential(
            username="student",
            username_selector="#username",
            password_selector="#password",
            submit_selector="#submit",
        )
        filled.raise_for_status()
        print("Filled:", filled.value["filled"], "submitted:", filled.value["submitted"])

        print("Landed on:", bw.run("return page.url()").value)


if __name__ == "__main__":
    main()
