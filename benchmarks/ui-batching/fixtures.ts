import http from "node:http";
import type { AddressInfo } from "node:net";

const pages = {
  form: `<label>Name <input id="name"></label><label>Region <select><option value="n">North</option><option value="s">South</option></select></label><label><input type="checkbox">Digest</label><button>Save</button><output role="status">Waiting</output><script>document.querySelector('button').onclick=()=>document.querySelector('output').textContent='Saved '+document.querySelector('#name').value+' '+document.querySelector('select').value+' '+document.querySelector('[type=checkbox]').checked</script>`,
  deferred: `<label>Query <input></label><button>Search</button><output role="status">Waiting</output><script>document.querySelector('button').onclick=()=>{fetch('/background');setTimeout(()=>document.querySelector('output').textContent='Found 12 records for '+document.querySelector('input').value,120)}</script>`,
  wizard: `<label>Code <input></label><button>Continue</button><output role="status">Waiting</output><script>document.querySelector('button').onclick=()=>{document.querySelector('button').disabled=true;setTimeout(()=>{document.querySelector('output').textContent='Ready to finish';const b=document.createElement('button');b.textContent='Finish';b.onclick=()=>document.querySelector('output').textContent='Finished '+document.querySelector('input').value;document.body.append(b)},120)}</script>`,
  frame: `<iframe name="settings" src="/frame-content"></iframe>`,
  "frame-content": `<label>Message <input></label><label>Priority <select><option>Normal</option><option>High</option></select></label><button>Apply</button><output role="status">Waiting</output><script>document.querySelector('button').onclick=()=>document.querySelector('output').textContent='Applied '+document.querySelector('input').value+' '+document.querySelector('select').value</script>`,
};

export async function startBatchFixtures() {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = http.createServer((request, response) => {
    const route = request.url?.split("/")[1];
    if (route === "background") {
      const timer = setTimeout(() => { timers.delete(timer); response.end("telemetry accepted"); }, 800);
      timers.add(timer);
      return;
    }
    if (!pages[route]) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(`<!doctype html><title>${route}</title>${pages[route]}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: listening on a TCP host/port guarantees AddressInfo.
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((resolve, reject) => {
    for (const timer of timers) clearTimeout(timer);
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }) };
}

const op = (id, action, target, value?) => {
  const operation = { id, action, target, value };
  if (value === undefined) delete operation.value;
  return operation;
};
const label = (name) => ({ label: name, exact: true });
const button = (name) => ({ role: "button", name, exact: true });
export const batchWorkloads = {
  form: { expected: "Saved Riley s true", operations: [
    op("name", "fill", label("Name"), "Riley"), op("region", "select", { role: "combobox", name: "Region", exact: true }, "s"),
    op("digest", "check", label("Digest")), op("save", "click", button("Save")),
    op("verify", "read", { role: "status" }, "Saved Riley s true"),
  ] },
  deferred: { expected: "Found 12 records for archive", operations: [
    op("query", "fill", label("Query"), "archive"), op("search", "click", button("Search")),
    op("verify", "read", { role: "status" }, "Found 12 records for archive"),
  ] },
  wizard: { expected: "Finished C-42", operations: [
    op("code", "fill", label("Code"), "C-42"), op("next", "click", button("Continue")),
    op("finish", "click", button("Finish")), op("verify", "read", { role: "status" }, "Finished C-42"),
  ] },
  frame: { expected: "Applied Review High", operations: [
    op("message", "fill", { ...label("Message"), frameName: "settings" }, "Review"),
    op("priority", "select", { role: "combobox", name: "Priority", exact: true, frameName: "settings" }, "High"),
    op("apply", "click", { ...button("Apply"), frameName: "settings" }),
    op("verify", "read", { role: "status", frameName: "settings" }, "Applied Review High"),
  ] },
};
