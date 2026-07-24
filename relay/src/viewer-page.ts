import { SECURITY_HEADERS } from "./constants";

function escapeAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => ({
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
    "<": "&lt;",
    ">": "&gt;",
  })[character] as string);
}

export function viewerPageResponse(sessionId: string, publicOrigin: string): Response {
  const wsOrigin = publicOrigin.replace(/^http/, "ws");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="theme-color" content="#0a0b0d">
  <meta name="bw-session-id" content="${escapeAttribute(sessionId)}">
  <title>BetterWright live view</title>
  <link rel="stylesheet" href="/viewer.css">
  <script type="module" src="/viewer.js"></script>
</head>
<body>
  <main class="viewer-shell">
    <header class="titlebar">
      <div class="brand" aria-label="BetterWright live view">
        <span class="brand-mark" aria-hidden="true"></span>
        <strong>Better<span>Wright</span></strong>
        <small>private relay</small>
      </div>
      <div id="status" class="status" role="status" aria-live="polite">
        <span aria-hidden="true"></span><b>Securing connection</b>
      </div>
    </header>

    <nav id="tabs" class="tabs" aria-label="Browser tabs"></nav>

    <section class="browser-bar" aria-label="Current page">
      <div class="address">
        <span class="lock-glyph" aria-hidden="true"></span>
        <span id="page-url">Waiting for the browser</span>
      </div>
      <span id="dimensions" class="dimensions"></span>
      <button id="control" type="button" disabled>Take control</button>
    </section>

    <section id="viewport" class="viewport">
      <canvas id="screen" width="1280" height="800" tabindex="0" aria-label="Remote browser screen"></canvas>
      <div id="overlay" class="overlay active">
        <span class="aperture" aria-hidden="true"></span>
        <strong id="overlay-title">Opening a private channel</strong>
        <p id="overlay-detail">The key stays in this tab and is never sent to the relay.</p>
      </div>
    </section>

    <section id="handoff" class="handoff" hidden>
      <div><strong>The agent needs you</strong><p id="handoff-detail"></p></div>
      <button id="cancel" class="quiet" type="button">Cancel step</button>
      <button id="done" type="button">Done, resume agent</button>
    </section>

    <section class="session-dock" aria-label="Session messages">
      <div id="messages" class="messages" aria-live="polite"></div>
      <form id="composer" autocomplete="off">
        <label class="sr-only" for="message">Message the agent</label>
        <input id="message" maxlength="2000" placeholder="Message the agent">
        <button id="send" type="submit">Send</button>
      </form>
    </section>
  </main>
  <div id="toasts" class="toasts" aria-live="polite"></div>
</body>
</html>`;

  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${wsOrigin}; img-src data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'; media-src 'none'; manifest-src 'none'`,
  );
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(html, { status: 200, headers });
}
