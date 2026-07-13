"""Make one native attempt at a simple CAPTCHA widget.

Run only against a flow you are authorized to complete:

    python examples/python/solve_captcha.py https://the-page-with-a-captcha/
"""

import sys

from betterwright import BetterWright


def main(url: str) -> int:
    with BetterWright() as bw:
        opened = bw.run(f"await page.goto({url!r}); return snapshot()")
        if not opened.ok:
            print(opened.error)
            return 1

        result = bw.run(
            """
            const checkbox = page.locator(
              'iframe[title*="challenge" i], iframe[src*="captcha" i]'
            ).first();
            const bounds = await checkbox.boundingBox();
            if (!bounds) return {found: false};
            return captcha.click(bounds);
            """,
            note="Trying the visible checkbox once",
        )
        print(result.value)
        if result.challenges:
            print("The challenge remains; stopping instead of retrying.")
            return 1
        return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
