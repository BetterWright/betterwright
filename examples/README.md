# Examples

Runnable TypeScript. Each needs the runtime installed first (`betterwright init`,
or `betterwright setup` for just the browser).

Bun 1.4 runs these directly:

```bash
bun add betterwright
bun examples/typescript/quickstart.ts
```

- [`quickstart.ts`](typescript/quickstart.ts) — navigate, read, and capture proof.
- [`multi_tab.ts`](typescript/multi_tab.ts) — drive two tabs concurrently.
- [`agent_batch.ts`](typescript/agent_batch.ts) — a whole task in two calls with AgentBatch.
