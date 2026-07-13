"""Drive a local dev server.

The default policy blocks localhost so an agent can't be steered into services
on the machine. Opt in explicitly when you're the one pointing it at your dev
server.

    # in one terminal:  python -m http.server 5173
    python examples/python/local_dev.py
"""

from betterwright import BetterWright, NetworkPolicy


def main() -> None:
    policy = NetworkPolicy(allow_loopback=True)
    with BetterWright(policy=policy) as bw:
        result = bw.run(
            "await page.goto('http://localhost:5173'); return page.title()",
            note="Opening the local dev server",
        )
        if not result.ok:
            print("Could not reach localhost:5173 — is the server running?")
            print(result.error)
            return
        print("Local page title:", result.value)


if __name__ == "__main__":
    main()
