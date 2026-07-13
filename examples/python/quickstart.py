"""Navigate to a page, read its title, and capture a proof screenshot.

    python examples/python/quickstart.py
"""

from betterwright import BetterWright


def main() -> None:
    with BetterWright() as bw:
        bw.run("await page.goto('https://example.com')", note="Opening example.com")

        title = bw.run("return page.title()")
        print("Title:", title.value)

        proof = bw.run("return screenshot({kind: 'proof', name: 'example-home'})")
        proof.raise_for_status()
        print("Proof:", proof.artifacts[0].media_reference)


if __name__ == "__main__":
    main()
