"""Sign up for an account with a generated password and a confirm field.

``generate_and_fill_credential`` creates a strong password with a CSPRNG, stores
it in the encrypted vault scoped to the page's origin, and fills both the
password and confirm-password fields — all inside the trusted worker. The secret
is never returned to this script, so a signup is completed without the password
ever touching your code or a model snippet.

    python examples/python/signup_with_generated_password.py
"""

from betterwright import BetterWright

SIGNUP_URL = "https://example.com/signup"  # point at a real signup form


def main() -> None:
    with BetterWright() as bw:
        bw.run(f"await page.goto({SIGNUP_URL!r})", note="Opening the signup page")

        result = bw.generate_and_fill_credential(
            username="ada@example.com",
            username_selector="#email",
            password_selector="#password",
            confirm_password_selector="#confirm-password",
            submit_selector="#create-account",
            label="example.com signup",
        )
        result.raise_for_status()
        print("New credential id:", result.value["id"])
        print("Filled fields:", result.value["filled"])

        # The generated password is retrievable later only by trusted host code
        # (bw.vault), scoped to this origin — never by a model snippet.
        for record in bw.vault.list_credentials("https://example.com"):
            print("Stored:", record["username"], record["label"])


if __name__ == "__main__":
    main()
