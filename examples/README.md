# Examples

Runnable scripts. Each needs the runtime installed first (`betterwright setup`).

### Python

```bash
pip install betterwright
python examples/python/quickstart.py
```

- [`quickstart.py`](python/quickstart.py) — navigate, read, and capture proof.
- [`login_with_vault.py`](python/login_with_vault.py) — store and fill a
  credential without the password reaching your code.
- [`signup_with_generated_password.py`](python/signup_with_generated_password.py) —
  sign up with a generated password and a confirm-password field.
- [`onepassword_attach.py`](python/onepassword_attach.py) — log in with your own
  1Password extension in an attached (auto-launched) real Chrome.
- [`local_dev.py`](python/local_dev.py) — drive a `localhost` dev server.
- [`solve_captcha.py`](python/solve_captcha.py) — native checkbox and text-challenge helpers.

### JavaScript

```bash
npm install betterwright
node examples/javascript/quickstart.mjs
```

- [`quickstart.mjs`](javascript/quickstart.mjs) — the JS equivalent.
- [`multi_tab.mjs`](javascript/multi_tab.mjs) — drive two tabs concurrently.
