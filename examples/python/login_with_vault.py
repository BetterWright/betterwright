"""Store a credential and fill it into a login form.

The password is written to the encrypted vault up front, then filled into the
page by the trusted worker — it is never returned to this script or to a model
driving the browser. Point it at a real login form to see it work end to end.

    python examples/python/login_with_vault.py
"""

from betterwright import BetterWright

LOGIN_URL = "https://practicetestautomation.com/practice-test-login/"


def main() -> None:
    with BetterWright() as bw:
        bw.run(f"await page.goto({LOGIN_URL!r})", note="Opening the login page")

        # Store the credential once, scoped to this page's origin.
        saved = bw.run(
            "return credentials.save({username: 'student', password: 'Password123'})"
        )
        print("Stored credential:", saved.value["id"])

        # Fill it. Only metadata comes back — never the password itself.
        filled = bw.run(
            "return credentials.fill({username: 'student', "
            "usernameSelector: '#username', passwordSelector: '#password'})"
        )
        print("Filled:", filled.value)

        bw.run("await page.click('#submit')", note="Submitting the form")
        result = bw.run("return page.url()")
        print("Landed on:", result.value)


if __name__ == "__main__":
    main()
