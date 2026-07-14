"""Log in using your own 1Password extension in an attached, real Chrome.

When you already keep logins in 1Password, the cleanest path is to let the
extension do the fill: BetterWright never sees the secret at all. This needs a
real Chrome with the 1Password extension installed and unlocked — not the
managed Cloak browser — so it uses attach mode.

    connect_over_cdp="auto"

reuses a debug Chrome if one is running, otherwise launches a real Google Chrome
with a persistent BetterWright profile (~/.betterwright/chrome-cdp-profile) and
attaches to it. Install and unlock 1Password in that profile once; every later
run reuses it.

One-time setup, in the auto-launched window:
  1. Install the 1Password extension and sign in.
  2. Unlock it (the agent cannot type your master password or pass biometrics).
  3. In 1Password's settings, keep "Show autofill menu on field focus" on.

    python examples/python/onepassword_attach.py

BetterWright's clicks emit real isTrusted events, which the extension's inline
menu accepts. If the extension is missing or locked, fall back to the trusted
vault fill (see login_with_vault.py).
"""

from betterwright import BetterWright

LOGIN_URL = "https://example.com/login"  # point at a real login form


def main() -> None:
    # Attach to your real Chrome (auto-launch one with your profile if needed).
    with BetterWright(connect_over_cdp="auto") as bw:
        bw.run(f"await page.goto({LOGIN_URL!r})", note="Opening the login page")

        # Focus the username field so 1Password shows its inline autofill menu,
        # then let the agent pick the matching login from the snapshot. The
        # exact markup of the inline menu is 1Password's own; drive it the way a
        # person would — inspect the snapshot and click the matching entry.
        bw.run(
            """
            await human.click('input[type="email"], input[name*="user" i], #username');
            return snapshot({ interactive: true });
            """,
            note="Opening the 1Password inline menu",
        )

        # From the snapshot above, the agent clicks the 1Password suggestion for
        # this site (its [ref=eN] marker), e.g.:
        #   await human.click(page.locator('aria-ref=e12'));
        # then submits the form. 1Password fills the fields; BetterWright never
        # handles the password.
        print("Inline 1Password menu opened — pick the matching login to autofill.")


if __name__ == "__main__":
    main()
