# Aside Browser — 28s promo (HyperFrames)

A 1920×1080, 30 fps, 28-second promo built with [HyperFrames](https://github.com/heygen-com/hyperframes)
(HTML + GSAP → deterministic MP4). The final render is `renders/aside-browser-promo.mp4`.

## Run it

Requires Node 22+ and FFmpeg. The CLI is pinned to `hyperframes@0.8.71` in `package.json`.

```bash
npx hyperframes@0.8.71 preview --background   # Studio at http://localhost:3002/#project/aside-browser-promo
npx hyperframes@0.8.71 check                  # lint + runtime + layout + motion + contrast
npx hyperframes@0.8.71 render --quality delivery --output renders/aside-browser-promo.mp4
```

## Beat sheet

| Time        | Beat                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------- |
| 0.0 – 4.3   | Glass window rises in. The camera pushes into "Ask AI a task", the prompt types, and the cursor presses Ask AI. |
| 4.3 – 7.4   | The plan appears. Agent tabs open for Sentry, acme/my-app and Vercel, and the sidebar count goes 0 → 3. |
| 7.4 – 10.7  | The vault key glows and the credentials autofill ("hidden from the AI"). The agent creates the Sentry project and pulls the DSN, masked, into the vault. |
| 10.7 – 14.3 | `@sentry/nextjs` diff, encrypted env vars, deploy progress to Ready.                              |
| 14.3 – 17.7 | Pay is clicked on production and the app throws `TypeError`. The screen flashes and shakes, and a Sentry issue arrives with the stack line and breadcrumbs. |
| 17.7 – 21.1 | The fix diff and a new test land, the suite passes 24/24, the app redeploys, and the issue is resolved. |
| 21.1 – 23.5 | "Production healthy." The status cards read Sentry connected, Deploy ready and 24/24 tests. The HUD shows "Done in 4m 28s". |
| 23.5 – 25.9 | "Bring the AI you already pay for." Continue with Claude or Codex, $0 extra for AI.             |
| 25.9 – 28.0 | "Aside Browser — The AI browser for real work."                                                 |

## How it follows HyperFrames best practice

These notes come from the official agent skills (`npx skills add heygen-com/hyperframes`, or
`npx hyperframes skills update <name>`): `hyperframes-core`, `-animation`, `-creative`, `-cli`
and the `general-video` workflow.

- **One paused, seekable timeline** registered at `window.__timelines["main"]`. It is built inside
  `document.fonts.ready` and registered only after the build finishes. The root `data-duration="28"`
  sets the render length.
- **Deterministic.** There is no `Date.now`, no `Math.random` and no infinite repeat. Typed text,
  URLs, the HUD clock and counters are pure functions of timeline time, driven by one `onUpdate`
  clock (the `discrete-text-sequence` rule). The caret blink is a sine square wave, not a CSS
  animation.
- **Clips own visibility.** Each pane is a `.clip` with `data-start` and `data-duration`. Tweens
  target the inner `.pi` wrapper and never the clip itself. Scene changes are simultaneous
  blur-crossfades: the transition is the exit.
- **`fromTo` over `from`.** Elements tweened more than once get `immediateRender: false`, so a
  non-linear seek never inherits whichever `fromTo` was authored last.
- **Layout is measured once at setup** with `offsetLeft`/`offsetTop`, not at tween time. It drives
  the cursor targets and the zoom-to-target camera math.
- **No network at render.** GSAP (`assets/vendor/`) and the fonts (`assets/fonts/`) are local,
  declared with `@font-face`. Inter is used for the product UI, Instrument Serif for the
  headlines, and JetBrains Mono for code.
- **Video-scale type:** UI text is at least 15px inside a 1600px window, captions are 56px and
  headlines 104–168px. The check passes WCAG AA outside mid-crossfade frames.

## Credits

GSAP 3.14.2 is used under the GreenSock standard no-charge license. Inter, Instrument Serif and
JetBrains Mono are used under the SIL Open Font License. Sentry, Vercel, GitHub, Claude and Codex
names appear only to depict the workflow.
