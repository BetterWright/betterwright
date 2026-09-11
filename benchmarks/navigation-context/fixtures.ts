import http from "node:http";
import type { AddressInfo } from "node:net";

const departments = ["Engineering", "Operations", "Design"];
const inventory = Array.from({ length: 24 }, (_, i) => ({
  name: `Device ${String(i + 1).padStart(2, "0")}`,
  department: departments[i % departments.length],
  available: i % 4 !== 0,
  count: i + 2,
}));

const navigation = `<nav>${Array.from({ length: 40 }, (_, i) => `<a href="/article/${i}">Reference section ${i + 1}</a>`).join(" ")}</nav>`;
const pages = {
  article: `<h1>Service handbook</h1><main><h2>Retention policy</h2><p>Standard records are retained for 45 days. Archived records are retained for 180 days. Export requests finish within 12 hours.</p></main>${navigation}`,
  form: `<h1>Notification preferences</h1><form><label>Display name <input name="displayName" required></label><label>Department <select name="department">${departments.map((name) => `<option>${name}</option>`).join("")}</select></label><label><input name="digest" type="checkbox">Weekly digest</label><button>Save preferences</button></form><output role="status"></output><script>document.querySelector('form').onsubmit = event => {event.preventDefault(); const values = Object.fromEntries(new FormData(event.target)); setTimeout(() => {document.querySelector('output').textContent = 'Saved: ' + JSON.stringify(values)}, 120)};</script>`,
  table: `<h1>Equipment inventory</h1><label>Department <select id="department"><option>All</option>${departments.map((name) => `<option>${name}</option>`).join("")}</select></label><label><input id="available" type="checkbox">Available only</label><table><thead><tr><th>Device</th><th>Department</th><th>Available</th><th>Count</th></tr></thead><tbody></tbody></table><script>const rows = ${JSON.stringify(inventory)}; function render() {document.querySelector('tbody').innerHTML = rows.filter(row => (department.value === 'All' || row.department === department.value) && (!available.checked || row.available)).map(row => '<tr><td>' + row.name + '</td><td>' + row.department + '</td><td>' + (row.available ? 'Yes' : 'No') + '</td><td>' + row.count + '</td></tr>').join('')} department.onchange = render; available.onchange = render; render();</script>`,
  deferred: '<h1>Loading report</h1><output role="status"></output><img src="/slow-image" alt="Decorative image"><script>setTimeout(() => {document.querySelector("output").textContent = "Report ready: 24 records"}, 120)</script>',
};

// Delayed resources occur in one explicit scenario only; ordinary fixtures
// have no artificial network delay. No external site or account is involved.
export async function startFixtures() {
  const server = http.createServer((request, response) => {
    const route = request.url?.split("/")[1];
    if (route === "slow-image") {
      setTimeout(() => { response.writeHead(204).end(); }, 800);
      return;
    }
    const content = pages[route];
    if (!content) { response.writeHead(404).end("Missing"); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(`<!doctype html><html><head><title>${route}</title></head><body>${content}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: listen succeeded on a TCP host/port, so the address is AddressInfo.
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

export const workloads = {
  article: { code: "return await page.locator('main').innerText()", expected: "Retention policy\n\nStandard records are retained for 45 days. Archived records are retained for 180 days. Export requests finish within 12 hours." },
  form: { code: "await page.getByLabel('Display name').fill('Taylor'); await page.getByLabel('Department').selectOption('Operations'); await page.getByLabel('Weekly digest').check(); await page.getByRole('button', {name:'Save preferences'}).click(); await page.getByRole('status').filter({hasText:'Saved:'}).waitFor(); return await page.getByRole('status').innerText()", expected: 'Saved: {"displayName":"Taylor","department":"Operations","digest":"on"}' },
  table: { code: "await page.getByLabel('Department').selectOption('Operations'); await page.getByLabel('Available only').check(); return await page.locator('tbody tr').allTextContents()", expected: inventory.filter((row) => row.department === "Operations" && row.available).map((row) => `${row.name}${row.department}Yes${row.count}`) },
  deferred: { code: "await page.getByRole('status').filter({hasText:'Report ready:'}).waitFor(); return await page.getByRole('status').innerText()", expected: "Report ready: 24 records" },
  directory: { route: "form", code: "return await controls.directory()", expected: null },
};
