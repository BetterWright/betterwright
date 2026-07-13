# CAPTCHA solving

![A puzzle piece completing a "verify you are human" challenge](assets/captcha.png)

When a legitimate, authorized flow stalls on a "verify you're human" wall, the
`captcha` module hands the challenge to a third-party solving service and returns
the token to inject back into the page. It speaks the `in.php` / `res.php`
protocol common to every 2Captcha-compatible provider, so the choice of service
is a base-URL change: **2Captcha, CapMonster, CapSolver, RuCaptcha**, and others.

> A CAPTCHA is a site asking automation to stop. This is a convenience for
> finishing a task *you own* — the same category as the credential vault — not a
> tool for bulk account creation, credential stuffing, or scraping behind
> anti-bot walls at scale. Use it accordingly.

## Configuration

The service key is read from the environment and never returned in a result:

```bash
export CAPTCHA_SOLVER_API_KEY="…"                 # or use the private key file below
export CAPTCHA_SOLVER_BASE_URL="https://2captcha.com"   # optional; default shown
```

For long-lived desktop agents, put only the key in
`$BETTERWRIGHT_HOME/captcha-api-key` (default
`~/.betterwright/captcha-api-key`) and set its permissions to `0600`. An explicit
constructor key wins, followed by the environment variable, then this private
file. `CAPTCHA_SOLVER_API_KEY_FILE` can point to another private file.

Check the key and balance before relying on it:

```bash
betterwright captcha --balance        # {"ok": true, "balance": "3.50"}
```

## The three-step flow

Solving a token CAPTCHA (reCAPTCHA, hCaptcha, Turnstile) is always: read the
sitekey off the page, send it to the service, inject the returned token. The
first and last steps are ordinary `run()` snippets; the middle step is the
solver.

```python
from betterwright import BetterWright
from betterwright.captcha import CaptchaSolver

bw = BetterWright()
solver = CaptchaSolver()   # reads the environment or private key file

# 1. Extract the sitekey and page URL
found = bw.run("""
  const el = document.querySelector('.g-recaptcha, [data-sitekey]');
  return { sitekey: el?.getAttribute('data-sitekey'), url: location.href };
""").value

# 2. Solve
solution = solver.recaptcha_v2(found["sitekey"], found["url"])

# 3. Inject the token and submit
bw.run(f"""
  document.querySelectorAll('textarea[name="g-recaptcha-response"]')
    .forEach(t => {{ t.value = {solution.token!r}; t.dispatchEvent(new Event('change', {{bubbles:true}})); }});
  await page.click('button[type=submit]');
""")
```

Ready-made detection/extraction/injection snippets for each CAPTCHA type are in
[browser-recipes.md](browser-recipes.md).

## Supported types

| Method | Needs | Notes |
| --- | --- | --- |
| `recaptcha_v2(sitekey, url, invisible=False)` | sitekey, url | Checkbox or invisible. |
| `recaptcha_v3(sitekey, url, action="verify", min_score=0.7)` | sitekey, url | Score-based. |
| `hcaptcha(sitekey, url)` | sitekey, url | |
| `turnstile(sitekey, url, action=None)` | sitekey, url | Cloudflare Turnstile. |
| `image(path_or_bytes)` | an image | Plain "type the characters" captchas. |

Each returns a `Solution(type, token, request_id)`. Failures raise
`CaptchaError`, whose message is the service's error code
(`ERROR_ZERO_BALANCE`, `ERROR_CAPTCHA_UNSOLVABLE`, `ERROR_TIMEOUT`, …).

## Image captchas: try vision first

For a plain image/text captcha — "type the wavy characters" — a vision model is
usually cheaper and faster than a paid solve. Screenshot the captcha element,
read it with whatever vision model your agent already has, and only fall back to
`solver.image(...)` when the read is unreadable or low-confidence.

```python
crop = bw.run("""
  const img = document.querySelector('img[src*="captcha" i]');
  const path = artifactPath('captcha.png');
  await (await page.$('img[src*="captcha" i]')).screenshot({ path });
  return path;
""").value
# → hand `crop` to your vision model; use solver.image(crop) only if it can't read it
```

## From the CLI

```bash
betterwright captcha --type recaptcha_v2 --sitekey 6Lc… --url https://example.com
betterwright captcha --type turnstile --sitekey 0x4… --url https://example.com --action login
betterwright captcha --type image --image ./captcha.png
```

Output is a single JSON object; the exit code is `0` on success and `1` on
failure, so a shell caller can branch on it.
