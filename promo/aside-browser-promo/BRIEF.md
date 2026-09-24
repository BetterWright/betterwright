---
workflow: general-video
flow: automation
storyboard: no
message: "One prompt in Aside sets up Sentry, ships, catches a production error, and fixes it — on the AI plan you already pay for."
destination: web-embed
aspect: 1920x1080
language: en
length: 28s
angle: product-demo
---

## Intent

A 28-second cinematic promo for Aside Browser in a soft lavender, glassy style.
It opens on the "Ask AI a task" bar and types: "Set up Sentry, deploy my app,
trigger a production error, then fix anything broken." The agent opens tabs
for Sentry, the codebase and Vercel. It signs in with secure autofill, creates
the Sentry project and pulls the DSN without exposing it. It writes the code
diff, sets env vars and deploys. The app throws a production error and Sentry
catches it. The agent fixes the bug, the tests pass, and it redeploys. The
success screen reads "Production healthy" and "Sentry connected". The close
pitches signing in with your own Claude or Codex subscription at no extra AI
cost, then the tagline "Aside Browser, the AI browser for real work."

## Customizations

- Agent status HUD with a fast-forward clock so a multi-minute job fits the cut.
- Zoom-to-target camera moves on the prompt, the vault autofill, and the Sentry catch.

## Notes

- No audio: the brief asked for picture only. Voiceover or a music bed can be
  added through `/media-use` (HeyGen TTS or local Kokoro).
- GSAP and all fonts are vendored under `assets/` so renders need no network.
- Built as one composition on purpose: the browser window, camera and HUD persist
  across every beat, and a sub-composition timeline cannot animate host elements.
  `lint` reports this as Studio-layout warnings, not errors.
