# BetterWright (Python)

**A persistent, policy-guarded Playwright browser for AI agents.**

BetterWright wraps Playwright in a long-lived, sandboxed Node worker that an
agent drives with ordinary Playwright JavaScript. On top of the raw API it adds
the parts an autonomous agent needs: a persistent profile, a network policy
enforced on every request, an encrypted credential vault, screenshot artifacts
for proof-of-work, and native CAPTCHA interaction helpers.

```python
from betterwright import BetterWright

with BetterWright() as bw:
    result = bw.run("await page.goto('https://example.com'); return page.title()")
    print(result.value)   # "Example Domain"
```

## Install

Requires **Node.js 22+** on `PATH`. The managed Cloak browser is downloaded
once by `setup`; its wrapper and Playwright runtime stay pinned by BetterWright.

```bash
pip install betterwright
betterwright setup     # installs Playwright + Cloak and verifies the signed binary
betterwright doctor    # confirms the runtime resolves
```

Stock Playwright Chromium remains an explicit compatibility/test fallback:
run `betterwright setup --chromium` and construct the client with
`browser="chromium"`. Cloak's wrapper is open source, while its downloaded
browser binary is separately licensed and is not redistributed in the wheel.

## Documentation

Full docs, the JavaScript client, and runnable examples are in the
[project repository](https://github.com/CuriosityOS/betterwright):

- [Getting started](https://github.com/CuriosityOS/betterwright/blob/main/docs/getting-started.md)
- [The browser API](https://github.com/CuriosityOS/betterwright/blob/main/docs/browser-api.md)
- [Network policy](https://github.com/CuriosityOS/betterwright/blob/main/docs/network-policy.md)
- [Credentials](https://github.com/CuriosityOS/betterwright/blob/main/docs/credentials.md)
- [Native CAPTCHA helpers](https://github.com/CuriosityOS/betterwright/blob/main/docs/captcha.md)
- [Architecture & security model](https://github.com/CuriosityOS/betterwright/blob/main/docs/architecture.md)
- [Python API reference](https://github.com/CuriosityOS/betterwright/blob/main/docs/python.md)

## License

MIT
