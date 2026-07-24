import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFile(`${root}/${path}`, "utf8");

describe("standalone package and deployment template", () => {
  it("declares the Worker, Clerk, Workers types, Wrangler, TypeScript, and Vitest", async () => {
    const packageJson = JSON.parse(await read("package.json"));
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");
    expect(packageJson.dependencies["@clerk/backend"]).toBeTruthy();
    expect(packageJson.devDependencies["@cloudflare/workers-types"]).toBeTruthy();
    expect(packageJson.devDependencies.vitest).toBeTruthy();
    expect(packageJson.devDependencies.wrangler).toBeTruthy();
    expect(packageJson.scripts.test).toContain("vitest run");
    expect(Object.values(packageJson.scripts).join(" ")).not.toMatch(/wrangler deploy/);
  });

  it("binds exactly the three required Durable Object classes and D1 migration directory", async () => {
    const wrangler = await read("wrangler.example.toml");
    expect(wrangler.match(/\[\[durable_objects\.bindings\]\]/g)).toHaveLength(3);
    expect(wrangler).toContain('class_name = "RelaySession"');
    expect(wrangler).toContain('class_name = "UserQuota"');
    expect(wrangler).toContain('class_name = "BudgetWindow"');
    expect(wrangler).toContain('new_sqlite_classes = ["RelaySession", "UserQuota", "BudgetWindow"]');
    expect(wrangler).toContain('migrations_dir = "migrations"');
    expect(wrangler).toContain('run_worker_first = true');
    expect(wrangler).toContain("WEEKLY_VIEWER_SECONDS = \"7200\"");
    expect(wrangler).toContain("LEASE_SECONDS = \"900\"");
    expect(wrangler).toContain("BUDGET_CEILING_USD = \"900\"");
    expect(wrangler).toContain("enabled = false");
  });
});

describe("D1 schema security invariants", () => {
  it("stores only HMAC hash columns for API and WebSocket capabilities", async () => {
    const migration = await read("migrations/0001_initial.sql");
    expect(migration).toContain("key_hash TEXT NOT NULL UNIQUE");
    expect(migration).toContain("host_cap_hash TEXT NOT NULL");
    expect(migration).toContain("viewer_cap_hash TEXT NOT NULL");
    expect(migration).not.toMatch(/api_key_secret|host_capability\s+text|viewer_capability\s+text|root_key\s+text/i);
  });

  it("enforces five active API keys atomically in SQLite", async () => {
    const migration = await read("migrations/0001_initial.sql");
    expect(migration).toContain("CREATE TRIGGER api_keys_max_five");
    expect(migration).toMatch(/COUNT\(\*\)[\s\S]*revoked_at_ms IS NULL[\s\S]*>= 5/);
    expect(migration).toContain("RAISE(ABORT, 'active_api_key_limit')");
  });

  it("contains no payload, frame, chat, or input log table", async () => {
    const migration = (await read("migrations/0001_initial.sql")).toLowerCase();
    expect(migration).not.toMatch(/create table (?:frames|messages|chat|input|payload)/);
  });
});

describe("documentation safety caveats", () => {
  it("states that Cloudflare alerts and the relay reservation are not an account spending cap", async () => {
    const readme = await read("README.md");
    expect(readme).toContain("Cloudflare budget alerts are informational");
    expect(readme).toContain("not a Cloudflare account spending cap");
    expect(readme).toContain("No deployment is performed");
  });

  it("documents the fragment key, peer-IP limitation, close codes, and challenge gate", async () => {
    const [readme, protocol] = await Promise.all([read("README.md"), read("docs/PROTOCOL.md")]);
    expect(readme).toContain("`#k=...`");
    expect(readme).toContain("Cloudflare necessarily observes each endpoint IP");
    expect(readme).toContain("4413");
    expect(protocol).toContain("does not inspect it");
    expect(protocol).toContain("refuses to release any viewer");
  });
});
