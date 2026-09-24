# Aside Browser — 28s promo

A 28-second, 1920×1080 promo for Aside Browser in a soft lavender glass style,
built with [HyperFrames](https://github.com/heygen-com/hyperframes) (HTML + GSAP
rendered to MP4 in headless Chrome).

The film is one continuous take inside a recreation of the Aside window. The user
types *"Set up Sentry, deploy my app, trigger a production error, then fix
anything broken."* into the Ask AI bar. The agent then:

1. opens Sentry, the codebase and Vercel as agent tabs,
2. fills the Sentry sign-in from the Aside vault, creates the project and captures the DSN as a secret,
3. adds `@sentry/nextjs` in a PR, sets the Vercel env vars and deploys,
4. triggers a checkout error, which Sentry catches,
5. patches `route.ts`, runs 24 passing tests and redeploys.

It ends on a success screen ("Production healthy", "Sentry connected"), a
bring-your-own Claude or Codex subscription beat, and the line *"Aside Browser.
The AI browser for real work."*

| Time | Beat |
| --- | --- |
| 0.0–3.2s | New Tab (1:1 UI), prompt typed into Ask AI |
| 3.2–6.2s | Agent tabs spin up: Sentry, acme/web, Vercel |
| 6.2–9.6s | Vault autofill, Sentry project, DSN captured |
| 9.6–13.4s | Code diff, env vars, deploy |
| 13.4–16.9s | 500 on checkout, Sentry issue and stack trace |
| 16.9–20.5s | Fix diff, tests pass, redeploy |
| 20.5–23.3s | Success screen, pull back to the full window |
| 23.3–25.9s | "No extra AI bill": sign in with Claude or Codex |
| 25.9–28.0s | End card |

## Working on it

Requires Node 22+ and FFmpeg.

```bash
npm run dev      # Studio preview with live reload
npm run check    # lint + runtime + layout + motion + contrast
npm run render   # renders/aside-browser-promo.mp4 (delivery quality, 30fps)
npm run score    # rebuild assets/score.m4a after retiming beats
```

- `index.html` holds the whole composition: one paused GSAP timeline registered on
  `window.__timelines.main`. Text that changes over time (typing, the URL bar,
  timers, counters) is driven by one seek-safe `state(t)` function.
- `tools/make-score.mjs` synthesises the soundtrack (pad plus UI sound marks) on
  the same schedule as the timeline. If you move a beat in `index.html`, move it
  there too.
- Everything the renderer needs is local: fonts in `assets/fonts`, GSAP in
  `assets/vendor`. Brand glyphs are inline SVG, several of them from
  [simple-icons](https://simpleicons.org).
- `BRIEF.md` records the brief the video was built from.
