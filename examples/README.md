# Examples

Runnable TypeScript. Each needs the runtime installed first (`betterwright init`,
or `betterwright setup` for just the browser).

Node runs these directly through its built-in type stripping, which needs
Node >= 22.18:

```bash
npm install betterwright
node examples/typescript/quickstart.ts
```

On an older Node 22, run them through a TypeScript loader (`tsx`, `ts-node`)
instead.

- [`quickstart.ts`](typescript/quickstart.ts) — navigate, read, and capture proof.
- [`multi_tab.ts`](typescript/multi_tab.ts) — drive two tabs concurrently.
