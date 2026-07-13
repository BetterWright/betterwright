"""The detect -> solve -> inject flow for a reCAPTCHA v2 page.

Requires CAPTCHA_SOLVER_API_KEY in the environment and a page that actually
shows a reCAPTCHA. Run only against a flow you are authorized to complete.

    export CAPTCHA_SOLVER_API_KEY=...
    python examples/python/solve_captcha.py https://the-page-with-a-captcha/
"""

import sys

from betterwright import BetterWright
from betterwright.captcha import CaptchaError, CaptchaSolver


def main(url: str) -> int:
    solver = CaptchaSolver()  # reads CAPTCHA_SOLVER_API_KEY
    with BetterWright() as bw:
        bw.run(f"await page.goto({url!r})", note="Opening the page")

        found = bw.run(
            """
            const el = document.querySelector('.g-recaptcha, [data-sitekey]');
            return { sitekey: el?.getAttribute('data-sitekey'), url: location.href };
            """
        ).value
        if not found.get("sitekey"):
            print("No reCAPTCHA sitekey found on the page.")
            return 1

        try:
            solution = solver.recaptcha_v2(found["sitekey"], found["url"])
        except CaptchaError as exc:
            print("Solve failed:", exc)
            return 1

        bw.run(
            f"""
            document.querySelectorAll('textarea[name="g-recaptcha-response"]')
              .forEach(t => {{ t.value = {solution.token!r};
                              t.dispatchEvent(new Event('change', {{bubbles: true}})); }});
            return true;
            """,
            note="Injecting the solved token",
        )
        print("Token injected. Submit the form as the flow requires.")
        return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
