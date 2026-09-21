import type { RequestListener } from "node:http";
import type { E2EContext, FixtureServer } from "./types.js";

export function documentHtml(body: string, title = "Browser fixture"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
    <style>body{font-family:system-ui;margin:24px}button,input,select,textarea{margin:8px;padding:8px}</style>
    </head><body>${body}</body></html>`;
}

function isHandler(route: string | RequestListener): route is RequestListener {
  return typeof route === "function";
}

export function serveBrowserFixture(
  ctx: E2EContext,
  routes: Record<string, string | RequestListener>,
): Promise<FixtureServer> {
  return ctx.serve((request, response) => {
    const route = routes[new URL(request.url || "/", "http://fixture.test").pathname];
    if (isHandler(route)) {
      route(request, response);
      return;
    }
    response.writeHead(route === undefined ? 404 : 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(route ?? "Not found");
  });
}

export const formHtml = documentHtml(`
  <form id="signup">
    <label>Display name <input name="display" value="Initial"></label>
    <label for="plan">Plan</label><select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    <label><input name="terms" type="checkbox"> Accept terms</label>
    <label>Notes <textarea name="notes">Original notes</textarea></label>
    <button>Create account</button>
  </form>
  <p role="status" id="status">Waiting</p>
  <script>
    window.submissions = 0;
    document.querySelector('form').onsubmit = event => {
      event.preventDefault();
      window.submissions++;
      const fields = event.target.elements;
      document.querySelector('#status').textContent = 'Created ' + fields.display.value + ' on ' + fields.plan.value + '; terms=' + fields.terms.checked;
    };
  </script>
`);

export const checkboxHtml = documentHtml(`
  <h1>Verify you are human</h1><p>I'm not a robot — complete the captcha to continue.</p>
  <div class="bw-captcha" data-bw-captcha="checkbox" style="width:320px;height:90px">
    <button id="checkbox" role="checkbox" aria-checked="false" aria-label="I'm not a robot" style="width:48px;height:48px">□</button>
    <span>I'm not a robot</span>
  </div>
  <input type="hidden" name="bw-captcha-response" value="">
  <p role="status">Waiting</p>
  <script>
    document.querySelector('#checkbox').onclick = event => {
      event.currentTarget.setAttribute('aria-checked', 'true');
      document.querySelector('[name="bw-captcha-response"]').value = 'bw_local_fixture_token';
      document.querySelector('[role="status"]').textContent = 'Verification complete';
      document.title = 'Verified';
    };
  </script>
`, "Local checkbox CAPTCHA");

export const gridHtml = documentHtml(`
  <h1>Select all images with traffic lights</h1><p>Please select all images containing a traffic light to continue.</p>
  <div class="bw-captcha" data-bw-captcha="grid">
    <div id="grid" style="display:grid;grid-template-columns:repeat(3,100px);gap:4px;width:308px"></div>
    <button id="verify">Verify</button>
  </div>
  <input type="hidden" name="bw-captcha-response" value=""><p role="status">Waiting</p>
  <script>
    const selected = new Set();
    for (let index = 0; index < 9; index++) {
      const button = document.createElement('button');
      button.className = 'rc-imageselect-tile';
      button.setAttribute('aria-label', [0,4,8].includes(index) ? 'traffic light' : 'other');
      button.style.cssText = 'width:100px;height:100px;margin:0;background:hsl(' + index * 40 + ',70%,40%);color:white';
      button.textContent = String(index + 1);
      button.onclick = () => {
        if (selected.has(index)) selected.delete(index); else selected.add(index);
        button.style.outline = selected.has(index) ? '3px solid blue' : 'none';
      };
      document.querySelector('#grid').appendChild(button);
    }
    document.querySelector('#verify').onclick = () => {
      if (selected.size !== 3 || ![0,4,8].every(index => selected.has(index))) return;
      document.querySelector('[name="bw-captcha-response"]').value = 'bw_grid_fixture_token';
      document.querySelector('[role="status"]').textContent = 'Grid complete';
      document.title = 'Verified';
    };
  </script>
`, "Local image-grid CAPTCHA");

export const animationHtml = documentHtml(`
  <label>Draft <input id="draft"></label><canvas width="320" height="180"></canvas>
  <script>
    window.frameNumber = 0;
    const drawing = document.querySelector('canvas').getContext('2d');
    function draw() {
      window.frameNumber++;
      drawing.fillStyle = '#164e63';
      drawing.fillRect(0,0,320,180);
      drawing.fillStyle = '#facc15';
      drawing.fillRect(window.frameNumber % 280,60,40,40);
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  </script>
`, "Recording fixture");
