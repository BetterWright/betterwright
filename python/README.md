# BetterWright (Python)

**A persistent, policy-guarded Playwright browser for AI agents.**

BetterWright wraps Playwright in a long-lived, sandboxed Node worker that an
agent drives with ordinary Playwright JavaScript. On top of the raw API it adds
the parts an autonomous agent needs: a persistent profile, a network policy
enforced on every request, an encrypted credential vault, screenshot artifacts
for proof-of-work, and optional CAPTCHA solving.

```python
from betterwright import BetterWright

with BetterWright() as bw:
    result = bw.run("await page.goto('https://example.com'); return page.title()")
    print(result.value)   # "Example Domain"
```

## Install

Requires **Node.js 18+** on `PATH`. Chromium is downloaded once by `setup`.

```bash
pip install betterwright
betterwright setup     # installs the pinned Playwright runtime + Chromium
betterwright doctor    # confirms the runtime resolves
```

## Documentation

Full docs, the JavaScript client, and runnable examples are in the
[project repository](https://github.com/betterwright/betterwright):

- [Getting started](https://github.com/betterwright/betterwright/blob/main/docs/getting-started.md)
- [The browser API](https://github.com/betterwright/betterwright/blob/main/docs/browser-api.md)
- [Network policy](https://github.com/betterwright/betterwright/blob/main/docs/network-policy.md)
- [Credentials](https://github.com/betterwright/betterwright/blob/main/docs/credentials.md)
- [CAPTCHA solving](https://github.com/betterwright/betterwright/blob/main/docs/captcha.md)
- [Architecture & security model](https://github.com/betterwright/betterwright/blob/main/docs/architecture.md)
- [Python API reference](https://github.com/betterwright/betterwright/blob/main/docs/python.md)

## License

MIT
