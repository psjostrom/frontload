# agent-budget

`agent-budget` is a local-first context and cost gateway for coding agents. It builds a compact repository index, generates task dossiers, reads files within a character budget, summarizes noisy command output, and logs approximate token usage.

## Install

```bash
pnpm install
pnpm build
```

## CLI

```bash
agent-budget init
agent-budget doctor --repo .
agent-budget index --repo .
agent-budget dossier "Fix stale chart tooltip value after sensor reconnect" --repo . --format markdown --budget 12000
agent-budget search "tooltip reconnect" --repo . --limit 10
agent-budget read src/chart/ChartTooltip.tsx --repo . --budget 4000
agent-budget run --repo . --kind test -- pnpm test
agent-budget diff --repo .
agent-budget compare-cost --repo . --base HEAD~1 --head HEAD
agent-budget budget --repo .
agent-budget mcp --repo .
```

Local state is written under `.agent-budget/`.

## Proof

```bash
pnpm proof
```

The proof workflow builds, tests, runs the fixture demo, and writes files under `proof/`.
