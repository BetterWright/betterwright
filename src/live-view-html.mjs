// The live-view page: one self-contained HTML document, no build step, no
// frameworks, no external assets. Served only by live-view.mjs behind the
// capability token.
//
// Design concept: the viewer IS a browser window wearing BetterWright
// brand chrome — the brand orange (#FF7A1A from favicon.svg) on layered
// near-blacks, executed with T3 Code's surface craft: surfaces separated
// by 2–4% luminance steps, hairline warm-white borders (7%/12%), buttons
// with an inset top highlight and a soft colored drop shadow, a bare
// dot-and-text live status (their "Working" idiom), and a session dock
// modeled on the T3 chat composer: always-on chat (message the agent while
// watching it work), elevated handoff / ask modes, ghost-cancel / solid-done
// actions. Status indicators are diamonds, echoing the glyph in the logo.
//
// The inner <script> deliberately avoids template literals so this file can
// wrap the whole document in one backtick string without escape noise.

// Branded password gate shown when the live view was started with a password.
// Same surface language as the viewer: near-black window, orange diamond,
// hairline borders. Posts to /login?t=… and reads ?auth=failed for the error.
export function liveViewLoginHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0b0b0c">
<title>BetterWright — Live View</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0b0c; --raised: #17181a;
    --line: rgba(255, 244, 223, 0.07); --line-strong: rgba(255, 244, 223, 0.12);
    --fill: rgba(255, 244, 223, 0.035);
    --text: #f5f3ed; --dim: #a39d93; --faint: #6e695f;
    --orange: #ff7a1a; --orange-hover: #f27313; --orange-active: #de690f;
    --orange-line: rgba(255, 122, 26, 0.38);
    --red-fg: #f87171; --red-soft: rgba(239, 68, 68, 0.13);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--text); padding: 20px;
    font: 13px/1.45 "DM Sans Variable", "DM Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #card {
    width: min(360px, 100%); background: var(--raised);
    border: 1px solid var(--line); border-radius: 16px; padding: 28px 26px 24px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }
  #card:focus-within { border-color: rgba(255, 122, 26, 0.5); }
  .mark { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .mark .sdot {
    width: 8px; height: 8px; border-radius: 2px; transform: rotate(45deg);
    background: var(--orange); flex: none;
  }
  .wordmark { font-weight: 600; letter-spacing: -0.01em; }
  .wordmark .wm-w { color: var(--orange); }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
  p { margin: 0 0 16px; color: var(--dim); }
  #err {
    display: none; margin: 0 0 12px; padding: 8px 11px; border-radius: 10px;
    font-size: 12.5px; color: var(--red-fg); background: var(--red-soft);
  }
  #err.active { display: block; }
  input {
    width: 100%; height: 38px; padding: 0 12px; margin-bottom: 12px;
    background: var(--fill); color: var(--text); font: inherit;
    border: 1px solid var(--line); border-radius: 10px; outline: none;
  }
  input::placeholder { color: var(--faint); }
  input:focus { border-color: var(--orange-line); }
  button {
    width: 100%; height: 38px; border-radius: 10px; font: inherit; font-weight: 600;
    background: var(--orange); border: 1px solid var(--orange-active); color: #170b02;
    cursor: pointer;
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.22), 0 1px 2px rgba(255, 122, 26, 0.24);
  }
  button:hover { background: var(--orange-hover); }
  button:active { box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.2); }
  .hint { margin-top: 14px; font-size: 11.5px; color: var(--faint); text-align: center; }
</style>
</head>
<body>
<form id="card" method="post">
  <div class="mark"><span class="sdot"></span><span class="wordmark">Better<span class="wm-w">Wright</span> <span style="color:var(--dim);font-weight:500">Live view</span></span></div>
  <h1>This live view is locked</h1>
  <p>Enter the password the person who started it set.</p>
  <div id="err">Wrong password — try again.</div>
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Unlock</button>
  <div class="hint">Sessions last 12 hours on this device.</div>
</form>
<script>
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  document.getElementById("card").action = "/login?t=" + encodeURIComponent(params.get("t") || "");
  if (params.get("auth") === "failed") document.getElementById("err").className = "active";
})();
</script>
</body>
</html>
`;
}

export function liveViewHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0b0b0c">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1024 1024'%3E%3Crect width='1024' height='1024' rx='220' fill='%230A0A0B'/%3E%3Cpath d='M 900 238 H 230 Q 145 238 145 323 V 790 H 358 L 615 522 L 756 665' fill='none' stroke='%23FF7A1A' stroke-width='150' stroke-linecap='butt' stroke-linejoin='miter'/%3E%3Cpath d='M 900 238 H 230 Q 145 238 145 323 V 790 H 358 L 615 522 L 756 665' fill='none' stroke='%23FFF4DF' stroke-width='24' stroke-linecap='butt' stroke-linejoin='miter'/%3E%3Cg transform='translate(828 705) rotate(45)'%3E%3Crect x='-72' y='-72' width='144' height='144' fill='%23FF7A1A'/%3E%3Crect x='-46' y='-46' width='92' height='92' fill='%23FFF4DF'/%3E%3Crect x='-27' y='-27' width='54' height='54' fill='%23FF7A1A'/%3E%3C/g%3E%3C/svg%3E">
<title>BetterWright — Live View</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0b0c; --win: #0f0f10; --chrome: #131314; --raised: #17181a; --inset: #0a0a0b;
    --line: rgba(255, 244, 223, 0.07); --line-strong: rgba(255, 244, 223, 0.12);
    --fill: rgba(255, 244, 223, 0.035); --fill-strong: rgba(255, 244, 223, 0.065);
    --text: #f5f3ed; --dim: #a39d93; --faint: #6e695f;
    --orange: #ff7a1a; --orange-hover: #f27313; --orange-active: #de690f; --orange-fg: #ffa154;
    --orange-soft: rgba(255, 122, 26, 0.14); --orange-line: rgba(255, 122, 26, 0.38);
    --amber: #f0b24e; --amber-soft: rgba(240, 178, 78, 0.09); --amber-line: rgba(240, 178, 78, 0.22);
    --red: #ef4444; --red-fg: #f87171; --red-soft: rgba(239, 68, 68, 0.13);
    --cream: #fff4df;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 16px; background: var(--bg); color: var(--text);
    font: 13px/1.45 "DM Sans Variable", "DM Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased; overflow: hidden;
  }
  ::selection { background: rgba(255, 122, 26, 0.3); }
  #win {
    height: 100%; display: flex; flex-direction: column;
    background: var(--win); border: 1px solid var(--line);
    border-radius: 14px; overflow: hidden;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }
  .spacer { flex: 1; }

  /* ---- brand bar ---- */
  #brandbar {
    display: flex; align-items: center; gap: 10px; height: 44px;
    padding: 0 14px; flex: none;
  }
  #brandbar .logo { width: 19px; height: 19px; flex: none; display: block; }
  .wordmark { font-weight: 600; letter-spacing: -0.01em; white-space: nowrap; color: var(--text); }
  .wordmark .wm-w { color: var(--orange); }
  .product {
    font-size: 10px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--orange-fg); background: var(--orange-soft);
    border-radius: 6px; padding: 2px 7px 1px; white-space: nowrap;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 7px; white-space: nowrap;
    font-size: 12px; font-weight: 500; letter-spacing: 0.01em; color: var(--dim);
  }
  .chip .sdot {
    width: 6px; height: 6px; border-radius: 1px; transform: rotate(45deg);
    background: var(--faint); flex: none;
  }
  .chip.driving { color: var(--orange-fg); }
  .chip.driving .sdot { background: var(--orange); animation: statuspulse 2s infinite; }
  .chip.handoff { color: var(--orange); font-weight: 600; }
  .chip.handoff .sdot { background: var(--orange); }
  .chip.reconnecting { color: var(--amber); }
  .chip.reconnecting .sdot { background: var(--amber); animation: statuspulse 1s infinite; }
  .chip.off { color: var(--red-fg); }
  .chip.off .sdot { background: var(--red); }
  @keyframes statuspulse {
    0%, 40% { opacity: 1; }
    50%, 90% { opacity: 0.45; }
    100% { opacity: 1; }
  }

  /* ---- tab strip: Chrome-style, active tab connected to the toolbar ---- */
  #tabStrip { flex: none; padding: 4px 10px 0; border-bottom: 1px solid var(--line); }
  #tabRow {
    display: flex; align-items: flex-end; gap: 2px;
    overflow-x: auto; scrollbar-width: none; min-height: 33px;
  }
  #tabRow::-webkit-scrollbar { display: none; }
  .tab {
    display: flex; align-items: center; gap: 8px; height: 32px;
    padding: 0 13px; border-radius: 9px 9px 0 0;
    border: 1px solid transparent; border-bottom: none;
    font-size: 12.5px; color: var(--dim); cursor: pointer;
    max-width: 220px; min-width: 0; flex: 0 1 auto; background: none;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .tab:hover { background: var(--fill); }
  .tab.active {
    background: var(--chrome); border-color: var(--line); color: var(--text);
    margin-bottom: -1px; padding-bottom: 1px;
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.03);
  }
  .tab .tdot {
    width: 5px; height: 5px; border-radius: 1px; transform: rotate(45deg);
    background: var(--faint); flex: none;
  }
  .tab.active .tdot { background: var(--orange); }
  .tab .tlabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #tabPreview {
    display: none; position: fixed; z-index: 50; width: 224px; height: 140px;
    background: #000 center top / cover no-repeat;
    border: 1px solid var(--line-strong); border-radius: 10px;
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.65); pointer-events: none;
  }

  /* ---- toolbar: address pill + stream dims + control ---- */
  #toolbar {
    display: flex; align-items: center; gap: 10px; height: 48px;
    padding: 0 12px; background: var(--chrome);
    border-bottom: 1px solid var(--line); flex: none;
  }
  #addrPill {
    flex: 1; display: flex; align-items: center; gap: 9px; height: 32px;
    padding: 0 12px; min-width: 0;
    background: var(--fill); border: 1px solid var(--line); border-radius: 10px;
  }
  #addrPill .glyph {
    width: 6px; height: 6px; border-radius: 1px; transform: rotate(45deg);
    border: 1.5px solid var(--orange); flex: none; opacity: 0.9;
  }
  #pageUrl {
    flex: 1; min-width: 0;
    font: 12px/1 "SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace;
    color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #dims {
    font: 11px/1 "SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace;
    color: var(--faint); font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  button {
    height: 32px; padding: 0 12px; border-radius: 10px; font: inherit; font-size: 13px;
    font-weight: 500; background: var(--fill); color: var(--text);
    border: 1px solid var(--line); cursor: pointer;
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.04);
    transition: background 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
  }
  button:hover { background: var(--fill-strong); border-color: var(--line-strong); }
  button:active { box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25); }
  button:disabled { opacity: 0.5; cursor: default; box-shadow: none; }
  button:focus-visible, .tab:focus-visible {
    outline: 2px solid var(--orange); outline-offset: 1px;
  }
  #controlBtn, #handoffDone, #chatSend {
    background: var(--orange); border-color: var(--orange-active); color: #170b02; font-weight: 600;
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.22), 0 1px 2px rgba(255, 122, 26, 0.24);
  }
  #controlBtn:hover:not(:disabled), #handoffDone:hover, #chatSend:hover:not(:disabled) {
    background: var(--orange-hover);
  }
  #controlBtn:active, #handoffDone:active, #chatSend:active {
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.2);
  }
  #controlBtn.control-on {
    background: transparent; border-color: var(--orange-line); color: var(--orange-fg);
    box-shadow: none;
  }
  #controlBtn.control-on:hover { background: var(--orange-soft); }
  #controlBtn.control-on:active { box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25); }

  /* ---- conflict strip ---- */
  #conflict {
    display: none; padding: 6px 14px; font-size: 12px; color: var(--amber);
    background: var(--amber-soft); border-bottom: 1px solid var(--amber-line);
    flex: none;
  }
  #conflict.active { display: block; }

  /* ---- viewport ---- */
  #viewport {
    flex: 1; position: relative; min-height: 0; background: #080809;
    display: flex; align-items: center; justify-content: center;
  }
  canvas { width: 100%; height: 100%; object-fit: contain; outline: none; display: block; }
  canvas.controlling { outline: 2px solid var(--orange); outline-offset: -2px; }
  #overlay {
    position: absolute; inset: 0; display: none; flex-direction: column; gap: 14px;
    align-items: center; justify-content: center; background: rgba(8, 8, 9, 0.8);
    color: var(--dim); font-size: 13px; text-align: center; padding: 20px;
  }
  #overlay.active { display: flex; }
  #overlay .spin {
    width: 22px; height: 22px; border-radius: 50%;
    border: 2.5px solid var(--line-strong); border-top-color: var(--orange);
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---- session dock: always-on chat + elevated handoff/ask ---- */
  #dock {
    flex: none; display: flex; flex-direction: column; max-height: min(38vh, 320px);
    padding: 0 12px 12px; border-top: 1px solid var(--line); background: var(--win);
  }
  #dock.elevated { animation: dock 0.15s ease-out; }
  @keyframes dock { from { opacity: 0; transform: translateY(6px); } }
  .h-card {
    background: var(--raised); border: 1px solid var(--line);
    border-radius: 16px; padding: 10px 12px 10px;
    box-shadow: 0 18px 48px -20px rgba(0, 0, 0, 0.6), 0 4px 14px -7px rgba(0, 0, 0, 0.4);
    transition: border-color 0.2s ease;
    display: flex; flex-direction: column; min-height: 0; max-height: inherit;
  }
  #dock.elevated .h-card { border-color: rgba(255, 122, 26, 0.28); }
  .h-card:focus-within { border-color: rgba(255, 122, 26, 0.5); }
  #modeBar {
    display: none; flex-direction: column; gap: 8px; margin-bottom: 8px;
    padding-bottom: 8px; border-bottom: 1px solid var(--line);
  }
  #modeBar.active { display: flex; }
  .h-head { display: flex; align-items: baseline; gap: 9px; min-width: 0; flex-wrap: wrap; }
  .h-dot {
    width: 6px; height: 6px; border-radius: 1px; transform: rotate(45deg);
    background: var(--orange); flex: none; align-self: center;
    animation: statuspulse 2s infinite;
  }
  .h-title { font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; }
  #modeDetail { color: var(--dim); overflow-wrap: anywhere; flex: 1; min-width: 0; }
  #askChips { display: none; flex-wrap: wrap; gap: 6px; }
  #askChips.active { display: flex; }
  .chip-btn {
    height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12px;
    background: var(--fill); color: var(--text); border: 1px solid var(--line);
    cursor: pointer; box-shadow: none;
  }
  .chip-btn:hover { background: var(--orange-soft); border-color: var(--orange-line); color: var(--orange-fg); }
  #chatLog {
    flex: 1; min-height: 72px; max-height: 160px; overflow-y: auto;
    display: flex; flex-direction: column; gap: 6px; padding: 2px 2px 6px;
    scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent;
  }
  .msg {
    display: flex; flex-direction: column; gap: 2px; max-width: 96%;
    animation: rise 0.12s ease-out;
  }
  .msg.you { align-self: flex-end; align-items: flex-end; }
  .msg.agent, .msg.system { align-self: flex-start; align-items: flex-start; }
  .msg .who {
    font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--faint);
  }
  .msg.you .who { color: var(--orange-fg); }
  .msg.agent .who { color: var(--dim); }
  .msg .bubble {
    font-size: 12.5px; line-height: 1.4; color: var(--text);
    padding: 7px 10px; border-radius: 12px; overflow-wrap: anywhere;
    background: var(--fill); border: 1px solid var(--line);
  }
  .msg.you .bubble {
    background: var(--orange-soft); border-color: var(--orange-line); color: var(--text);
  }
  .msg.system .bubble { color: var(--dim); font-size: 12px; }
  .msg .kind {
    display: inline-block; margin-right: 6px; font-size: 10px; font-weight: 600;
    letter-spacing: 0.06em; text-transform: uppercase; color: var(--orange-fg);
  }
  #composer { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  #chatInput {
    flex: 1; min-width: 0; height: 34px; padding: 0 10px;
    background: var(--fill); color: var(--text); font: inherit; font-size: 13px;
    border: 1px solid var(--line); border-radius: 10px; outline: none;
  }
  #chatInput::placeholder { color: var(--faint); }
  #chatInput:focus { border-color: var(--orange-line); }
  #chatSend { height: 34px; padding: 0 14px; flex: none; }
  .h-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .h-hint { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--faint); }
  .kbd {
    font: 11px/1 "SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, Menlo, monospace;
    color: var(--dim); border: 1px solid var(--line-strong); border-radius: 5px; padding: 2px 5px;
  }
  #handoffActions { display: none; }
  #handoffActions.active { display: flex; }
  #handoffCancel { background: transparent; border-color: transparent; box-shadow: none; color: var(--dim); }
  #handoffCancel:hover { background: var(--fill-strong); border-color: transparent; color: var(--text); }

  /* ---- toasts ---- */
  #toasts { position: fixed; right: 24px; top: 60px; display: flex; flex-direction: column; gap: 8px; z-index: 60; }
  .toast {
    display: flex; align-items: center; gap: 9px;
    background: var(--raised); border: 1px solid var(--line-strong);
    border-radius: 10px; padding: 9px 13px; font-size: 12.5px; max-width: 320px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); animation: rise 0.15s ease-out;
  }
  .toast::before {
    content: ""; width: 5px; height: 5px; border-radius: 1px; flex: none;
    transform: rotate(45deg); background: var(--orange);
  }
  @keyframes rise { from { opacity: 0; transform: translateY(5px); } }
</style>
</head>
<body>
<div id="win">
  <header id="brandbar">
    <svg class="logo" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M 900 238 H 230 Q 145 238 145 323 V 790 H 358 L 615 522 L 756 665" fill="none" stroke="#FF7A1A" stroke-width="150" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M 900 238 H 230 Q 145 238 145 323 V 790 H 358 L 615 522 L 756 665" fill="none" stroke="#FFF4DF" stroke-width="24" stroke-linecap="butt" stroke-linejoin="miter"/><g transform="translate(828 705) rotate(45)"><rect x="-72" y="-72" width="144" height="144" fill="#FF7A1A"/><rect x="-46" y="-46" width="92" height="92" fill="#FFF4DF"/><rect x="-27" y="-27" width="54" height="54" fill="#FF7A1A"/></g></svg>
    <span class="wordmark">Better<span class="wm-w">Wright</span></span>
    <span class="product">Live view</span>
    <div class="spacer"></div>
    <span id="statusChip" class="chip idle"><span class="sdot"></span><span id="statusText">connecting…</span></span>
  </header>
  <div id="tabStrip"><div id="tabRow"></div></div>
  <div id="toolbar">
    <div id="addrPill"><span class="glyph"></span><span id="pageUrl"></span></div>
    <span id="dims"></span>
    <button id="controlBtn" disabled>Take control</button>
  </div>
  <div id="conflict">The agent is driving right now — your clicks and keys may conflict with it.</div>
  <div id="viewport">
    <canvas id="screen" tabindex="0" width="1280" height="800"></canvas>
    <div id="overlay"><div class="spin"></div><div id="overlayText">Connecting to the browser…</div></div>
  </div>
  <div id="dock">
    <div class="h-card">
      <div id="modeBar">
        <div class="h-head">
          <span class="h-dot"></span>
          <span class="h-title" id="modeTitle">The agent needs you</span>
          <span id="modeDetail"></span>
        </div>
        <div id="askChips"></div>
        <div id="handoffActions" class="h-actions">
          <span class="h-hint">Drive the browser, then resume</span>
          <div class="spacer"></div>
          <button id="handoffCancel">Cancel step</button>
          <button id="handoffDone">Done — resume agent</button>
        </div>
      </div>
      <div id="chatLog" aria-live="polite"></div>
      <div id="composer">
        <input id="chatInput" placeholder="Message the agent…" maxlength="2000" autocomplete="off">
        <button id="chatSend" type="button">Send</button>
      </div>
      <div class="h-actions" style="margin-top:6px">
        <span class="h-hint" id="composerHint"><span class="kbd">⏎</span> send · delivered next turn</span>
      </div>
    </div>
  </div>
</div>
<div id="tabPreview"></div>
<div id="toasts"></div>
<script>
(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("t") || "";
  var canvas = document.getElementById("screen");
  // Opaque + desynchronized: skips alpha compositing and (where supported)
  // lets frames hit the display without waiting on the DOM raster pipeline.
  var ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  var viewportEl = document.getElementById("viewport");
  var chip = document.getElementById("statusChip");
  var chipText = document.getElementById("statusText");
  var controlBtn = document.getElementById("controlBtn");
  var tabRow = document.getElementById("tabRow");
  var tabPreview = document.getElementById("tabPreview");
  var pageUrl = document.getElementById("pageUrl");
  var dims = document.getElementById("dims");
  var dock = document.getElementById("dock");
  var modeBar = document.getElementById("modeBar");
  var modeTitle = document.getElementById("modeTitle");
  var modeDetail = document.getElementById("modeDetail");
  var askChips = document.getElementById("askChips");
  var handoffActions = document.getElementById("handoffActions");
  var chatLog = document.getElementById("chatLog");
  var chatInput = document.getElementById("chatInput");
  var chatSend = document.getElementById("chatSend");
  var composerHint = document.getElementById("composerHint");
  var overlay = document.getElementById("overlay");
  var overlayText = document.getElementById("overlayText");
  var conflict = document.getElementById("conflict");
  var toasts = document.getElementById("toasts");

  var ws = null;
  var attempts = 0;
  var ended = false;
  var meta = { deviceWidth: 1280, deviceHeight: 800, url: "" };
  var agentState = "idle";
  var interactiveAllowed = false;
  var handoffActive = false;
  var askActive = false;
  var askOptions = [];
  var controlling = false;
  var frameCount = 0;
  var fps = 0;
  var lastDown = { time: 0, x: 0, y: 0, count: 0 };
  var decodeBusy = false;
  var pendingBlob = null;
  var seenChatIds = {};
  var tabEls = {}; // id -> { el, label, tab } — updated in place, never rebuilt
  var thumbs = {}; // id -> data URL, pushed as per-tab deltas
  var previewTabId = null;
  var viewTimer = null;

  function toast(text) {
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    toasts.appendChild(el);
    setTimeout(function () { el.remove(); }, 4200);
  }

  function send(message) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  function setStatus(state) {
    var labels = {
      driving: "agent driving",
      idle: "idle",
      handoff: "handoff — you drive",
      reconnecting: "reconnecting…",
      off: "disconnected"
    };
    chip.className = "chip " + state;
    chipText.textContent = labels[state] || state;
  }

  function renderMeta() {
    pageUrl.textContent = meta.url || "";
    dims.textContent =
      meta.deviceWidth + "×" + meta.deviceHeight + (fps > 0 ? " · " + fps + " fps" : "");
  }

  function refreshControls() {
    var canControl = interactiveAllowed || handoffActive;
    controlBtn.disabled = !canControl;
    controlBtn.title = canControl ? "" : "This live view is watch-only.";
    if (!canControl) controlling = false;
    if (handoffActive) controlling = true;
    controlBtn.textContent = controlling ? "Release control" : "Take control";
    controlBtn.className = controlling ? "control-on" : "";
    canvas.className = controlling ? "controlling" : "";
    conflict.className =
      controlling && agentState === "driving" && !handoffActive ? "active" : "";
    var elevated = handoffActive || askActive;
    dock.className = elevated ? "elevated" : "";
    modeBar.className = elevated ? "active" : "";
    handoffActions.className = handoffActive ? "h-actions active" : "h-actions";
    if (handoffActive) {
      modeTitle.textContent = "The agent needs you";
      chatInput.placeholder = "Optional note for after you resume…";
      composerHint.innerHTML = "<span class='kbd'>⏎</span> send note · then Done to resume";
    } else if (askActive) {
      modeTitle.textContent = "The agent is asking";
      chatInput.placeholder = "Type your answer…";
      composerHint.innerHTML = "<span class='kbd'>⏎</span> send answer";
    } else {
      chatInput.placeholder = "Message the agent…";
      composerHint.innerHTML = "<span class='kbd'>⏎</span> send · delivered next turn";
    }
    setStatus(handoffActive ? "handoff" : agentState);
  }

  function appendChatMessage(message) {
    if (!message || !message.text) return;
    if (message.id != null) {
      if (seenChatIds[message.id]) return;
      seenChatIds[message.id] = true;
    }
    var role = message.role === "you" ? "you" : message.role === "system" ? "system" : "agent";
    var el = document.createElement("div");
    el.className = "msg " + role;
    var who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "you" ? "you" : role === "system" ? "system" : "agent";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    if (message.kind && role === "agent") {
      var kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = message.kind;
      bubble.appendChild(kind);
    }
    bubble.appendChild(document.createTextNode(message.text));
    el.appendChild(who);
    el.appendChild(bubble);
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function renderAskChips(options) {
    askChips.innerHTML = "";
    askOptions = Array.isArray(options) ? options : [];
    if (!askActive || !askOptions.length) {
      askChips.className = "";
      return;
    }
    askChips.className = "active";
    for (var i = 0; i < askOptions.length; i += 1) {
      (function (label) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chip-btn";
        btn.textContent = label;
        btn.addEventListener("click", function () {
          send({ t: "answer", text: label });
          chatInput.value = "";
        });
        askChips.appendChild(btn);
      })(askOptions[i]);
    }
  }

  function sendChat() {
    var text = chatInput.value.trim();
    if (!text) return;
    send({ t: "chat", text: text });
    chatInput.value = "";
    chatInput.focus();
  }

  controlBtn.addEventListener("click", function () {
    controlling = !controlling;
    if (controlling) canvas.focus();
    refreshControls();
  });

  // ---- frame pipeline: decode latest-wins, skip while the tab is hidden ----
  function drawBlob(blob) {
    if (document.hidden) return Promise.resolve();
    var painter = function (bitmap) {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        // Resizing resets context state; restore high-quality scaling for
        // the thumbnail placeholder draws.
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
      }
      ctx.drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();
    };
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(blob).then(painter, function () {});
    }
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { painter(img); URL.revokeObjectURL(url); resolve(); };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(); };
      img.src = url;
    });
  }

  function pumpFrames() {
    if (decodeBusy || !pendingBlob) return;
    var blob = pendingBlob;
    pendingBlob = null;
    decodeBusy = true;
    drawBlob(blob).then(function () {
      decodeBusy = false;
      pumpFrames();
    });
  }

  setInterval(function () {
    fps = frameCount * 2;
    frameCount = 0;
    renderMeta();
  }, 500);

  // ---- tab row: browser-style tabs, updated in place so hover, focus and
  // previews survive the periodic refresh instead of flickering ----
  function showPreview(id, target) {
    if (!thumbs[id]) return;
    previewTabId = id;
    var rect = target.getBoundingClientRect();
    tabPreview.style.backgroundImage = "url(" + thumbs[id] + ")";
    tabPreview.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 240)) + "px";
    tabPreview.style.top = rect.bottom + 8 + "px";
    tabPreview.style.display = "block";
  }
  function hidePreview() {
    previewTabId = null;
    tabPreview.style.display = "none";
  }
  function paintThumbPlaceholder(id) {
    // Instant feedback on tab switch: stretch the low-res thumbnail onto the
    // canvas until the first real frame of the new tab lands.
    if (!thumbs[id]) return;
    var img = new Image();
    img.onload = function () {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = thumbs[id];
  }
  function makeTab(id) {
    var entry = { tab: null };
    var el = document.createElement("button");
    el.type = "button";
    el.className = "tab";
    var dot = document.createElement("span");
    dot.className = "tdot";
    var label = document.createElement("span");
    label.className = "tlabel";
    el.appendChild(dot);
    el.appendChild(label);
    el.addEventListener("click", function () {
      if (!entry.tab || entry.tab.streaming) return;
      hidePreview();
      send({ t: "tab", id: id });
      paintThumbPlaceholder(id);
      canvas.focus();
    });
    el.addEventListener("mouseenter", function () {
      if (entry.tab && !entry.tab.streaming) showPreview(id, el);
    });
    el.addEventListener("mouseleave", hidePreview);
    entry.el = el;
    entry.label = label;
    return entry;
  }
  function renderTabs(tabs) {
    var seen = {};
    var orderChanged = tabRow.children.length !== tabs.length;
    for (var i = 0; i < tabs.length; i += 1) {
      var tab = tabs[i];
      seen[tab.id] = true;
      var entry = tabEls[tab.id];
      if (!entry) {
        entry = makeTab(tab.id);
        tabEls[tab.id] = entry;
      }
      entry.tab = tab;
      var text = tab.title || tab.url || "about:blank";
      if (entry.label.textContent !== text) entry.label.textContent = text;
      var cls = "tab" + (tab.streaming ? " active" : "");
      if (entry.el.className !== cls) entry.el.className = cls;
      if (tabRow.children[i] !== entry.el) orderChanged = true;
      if (tab.streaming) {
        document.title = (tab.title ? tab.title + " — " : "") + "BetterWright Live View";
        if (!meta.url && tab.url) { meta.url = tab.url; renderMeta(); }
      }
    }
    for (var id in tabEls) {
      if (!seen[id]) {
        tabEls[id].el.remove();
        delete tabEls[id];
        delete thumbs[id];
        if (previewTabId === id) hidePreview();
      }
    }
    if (orderChanged) {
      for (var j = 0; j < tabs.length; j += 1) tabRow.appendChild(tabEls[tabs[j].id].el);
    }
  }

  // ---- session dock: chat + handoff/ask modes ----
  function finishHandoff(kind) {
    send({ t: kind, note: chatInput.value.trim() });
    chatInput.value = "";
  }
  document.getElementById("handoffDone").addEventListener("click", function () {
    finishHandoff("done");
  });
  document.getElementById("handoffCancel").addEventListener("click", function () {
    finishHandoff("cancel");
  });
  chatSend.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      sendChat();
    }
  });

  function applyHandoff(handoff) {
    var wasActive = handoffActive;
    handoffActive = Boolean(handoff && handoff.active);
    if (handoffActive) {
      modeDetail.textContent = handoff.prompt || "The agent paused for you.";
      if (!wasActive) {
        toast("The agent handed you control.");
        canvas.focus();
      }
    } else if (wasActive) {
      toast("Control returned to the agent.");
    }
    refreshControls();
  }

  function applyAsk(ask) {
    var wasActive = askActive;
    askActive = Boolean(ask && ask.active);
    if (askActive) {
      modeDetail.textContent = ask.question || "The agent has a question.";
      renderAskChips(ask.options || []);
      if (!wasActive) {
        toast("The agent is asking you something.");
        chatInput.focus();
      }
    } else {
      renderAskChips([]);
      if (wasActive) toast("Answer sent.");
    }
    refreshControls();
  }

  // ---- input relay ----
  function scaleCoords(event) {
    // object-fit: contain letterboxes the bitmap inside the canvas rect, so
    // map through the drawn content box, not the element box.
    var rect = canvas.getBoundingClientRect();
    var aspect = canvas.width > 0 && canvas.height > 0 ? canvas.width / canvas.height : rect.width / rect.height;
    var cw = Math.min(rect.width, rect.height * aspect);
    var ch = cw / aspect;
    var ox = rect.left + (rect.width - cw) / 2;
    var oy = rect.top + (rect.height - ch) / 2;
    var x = ((event.clientX - ox) / cw) * meta.deviceWidth;
    var y = ((event.clientY - oy) / ch) * meta.deviceHeight;
    x = Math.min(Math.max(x, 0), meta.deviceWidth);
    y = Math.min(Math.max(y, 0), meta.deviceHeight);
    return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
  }
  function modifiersOf(event) {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  }
  var BUTTON_NAMES = ["left", "middle", "right", "back", "forward"];

  function mouseEvent(type, event, extra) {
    var point = scaleCoords(event);
    var message = {
      t: "input", kind: "mouse", type: type,
      x: point.x, y: point.y,
      button: BUTTON_NAMES[event.button] || "none",
      buttons: event.buttons || 0,
      modifiers: modifiersOf(event),
      clickCount: extra && extra.clickCount ? extra.clickCount : 0
    };
    if (extra && extra.deltaX !== undefined) { message.deltaX = extra.deltaX; message.deltaY = extra.deltaY; }
    send(message);
  }

  canvas.addEventListener("pointerdown", function (event) {
    if (!controlling) return;
    event.preventDefault();
    canvas.focus();
    var point = scaleCoords(event);
    var now = Date.now();
    if (now - lastDown.time < 400 && Math.abs(point.x - lastDown.x) < 6 && Math.abs(point.y - lastDown.y) < 6) {
      lastDown.count += 1;
    } else {
      lastDown.count = 1;
    }
    lastDown.time = now; lastDown.x = point.x; lastDown.y = point.y;
    mouseEvent("mousePressed", event, { clickCount: lastDown.count });
  });
  canvas.addEventListener("pointerup", function (event) {
    if (!controlling) return;
    event.preventDefault();
    mouseEvent("mouseReleased", event, { clickCount: lastDown.count || 1 });
  });
  var moveQueued = null;
  canvas.addEventListener("pointermove", function (event) {
    if (!controlling) return;
    if (moveQueued) { moveQueued = event; return; }
    moveQueued = event;
    requestAnimationFrame(function () {
      var pending = moveQueued;
      moveQueued = null;
      if (pending && controlling) mouseEvent("mouseMoved", pending);
    });
  });
  canvas.addEventListener("wheel", function (event) {
    if (!controlling) return;
    event.preventDefault();
    // CDP wheel deltas follow the DOM convention here: positive deltaY
    // scrolls down (verified against the managed browser in e2e).
    mouseEvent("mouseWheel", event, { deltaX: event.deltaX, deltaY: event.deltaY });
  }, { passive: false });
  canvas.addEventListener("contextmenu", function (event) {
    if (controlling) event.preventDefault();
  });

  function uiHasFocus() {
    // Keys belong to the page unless a viewer control (chat box, tab button,
    // dock buttons) is focused — then they must stay in the UI.
    var active = document.activeElement;
    if (!active || active === canvas || active === document.body) return false;
    var tag = active.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON";
  }
  function keyMessage(type, event) {
    var message = {
      t: "input", kind: "key", type: type,
      key: event.key, code: event.code,
      keyCode: event.keyCode || 0,
      modifiers: modifiersOf(event)
    };
    if (type === "keyDown") {
      if (event.key === "Enter") message.text = "\\r";
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) message.text = event.key;
    }
    return message;
  }
  window.addEventListener("keydown", function (event) {
    if (!controlling || uiHasFocus()) return;
    event.preventDefault();
    send(keyMessage("keyDown", event));
  });
  window.addEventListener("keyup", function (event) {
    if (!controlling || uiHasFocus()) return;
    event.preventDefault();
    send(keyMessage("keyUp", event));
  });
  window.addEventListener("paste", function (event) {
    if (!controlling || uiHasFocus()) return;
    var text = (event.clipboardData || window.clipboardData).getData("text");
    if (text) send({ t: "input", kind: "insertText", text: text });
    event.preventDefault();
  });

  // ---- connection with backoff + jitter ----
  function showOverlay(text) {
    overlayText.textContent = text;
    overlay.className = "active";
  }
  function hideOverlay() { overlay.className = ""; }

  function connect() {
    if (ended) return;
    var scheme = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(scheme + location.host + "/ws?t=" + encodeURIComponent(token));
    ws.binaryType = "arraybuffer";
    ws.onopen = function () {
      attempts = 0;
      hideOverlay();
      send({ t: "refresh" });
      sendView();
      if (document.hidden) send({ t: "vis", hidden: true });
    };
    ws.onmessage = function (event) {
      if (typeof event.data !== "string") {
        frameCount += 1;
        pendingBlob = new Blob([event.data], { type: "image/jpeg" });
        pumpFrames();
        return;
      }
      var message;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message.t === "hello" || message.t === "state") {
        agentState = message.agent === "driving" ? "driving" : message.agent === "handoff" ? "handoff" : "idle";
        if (agentState === "handoff") agentState = "idle"; // the dock carries the handoff state
        interactiveAllowed = Boolean(message.interactive);
        applyHandoff(message.handoff);
        applyAsk(message.ask);
      } else if (message.t === "chat") {
        if (Array.isArray(message.messages)) {
          for (var i = 0; i < message.messages.length; i += 1) appendChatMessage(message.messages[i]);
        } else if (message.message) {
          appendChatMessage(message.message);
        }
      } else if (message.t === "meta") {
        if (message.deviceWidth > 0) meta.deviceWidth = message.deviceWidth;
        if (message.deviceHeight > 0) meta.deviceHeight = message.deviceHeight;
        if (typeof message.url === "string" && message.url) meta.url = message.url;
        renderMeta();
      } else if (message.t === "tabs") {
        renderTabs(message.tabs || []);
      } else if (message.t === "thumb") {
        if (message.id) {
          thumbs[message.id] = message.thumb || "";
          if (previewTabId === message.id && message.thumb) {
            tabPreview.style.backgroundImage = "url(" + message.thumb + ")";
          }
        }
      } else if (message.t === "toast") {
        toast(message.text || "");
      } else if (message.t === "bye") {
        ended = true;
        setStatus("off");
        overlay.querySelector(".spin").style.display = "none";
        showOverlay("Live view ended (" + (message.reason || "stopped") + "). You can close this tab.");
      }
    };
    ws.onclose = function () {
      if (ended) return;
      if (attempts >= 90) {
        // ~15 minutes of retries: the host is gone for good (a deliberate
        // stop would have sent "bye" long before this). Stop hammering.
        ended = true;
        setStatus("off");
        overlay.querySelector(".spin").style.display = "none";
        showOverlay("Live view ended (browser unreachable). You can close this tab.");
        return;
      }
      setStatus("reconnecting");
      attempts += 1;
      var delay = Math.min(10000, 600 * Math.pow(1.6, Math.min(attempts, 8))) + Math.random() * 300;
      showOverlay(
        attempts < 3
          ? "Reconnecting to the browser…"
          : "Browser unreachable (worker restarting or stopped). Retrying… (attempt " + attempts + ")"
      );
      setTimeout(connect, delay);
    };
    ws.onerror = function () {
      try { ws.close(); } catch (error) { /* ignored */ }
    };
  }

  // ---- keep the server informed: viewport size (so it never streams more
  // pixels than the biggest window shows) and tab visibility (so hidden
  // viewers cost no bandwidth) ----
  function sendView() {
    var rect = viewportEl.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    var px = Math.ceil(Math.max(rect.width, rect.height) * dpr);
    if (px > 0) send({ t: "view", px: px });
  }
  window.addEventListener("resize", function () {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(sendView, 300);
  });
  document.addEventListener("visibilitychange", function () {
    send({ t: "vis", hidden: document.hidden });
    if (!document.hidden) pumpFrames();
  });

  setStatus("idle");
  showOverlay("Connecting to the browser…");
  renderMeta();
  connect();
})();
</script>
</body>
</html>
`;
}
