# Pixels

A pixel-first bitmap editor. See `AGENTS.md` for architecture and toolchain decisions.

## Development

```sh
bun install
bun run dev
```

Open the URL printed by Vite (usually <http://localhost:5173>). Both `/` and `/d/$docId` are routed by TanStack Router.

## Quality gates

```sh
bun run check
bun test
bun run build
bun run perf --repeat 5
```

`bun run perf` is being implemented alongside the pixel core. It is not yet a passing gate.

Features own their framework-free `core/`, React `ui/`, tests, and perf cases. Other features import only through each feature's `index.ts`.
