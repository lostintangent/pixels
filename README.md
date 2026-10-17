# Pixels!

A pixel-first bitmap editor. See `AGENTS.md` for architecture and toolchain decisions.

## Development

Pixels needs Bun 1.4.3-canary.1 (4b02e1031) or newer. Install it with `bun upgrade --canary`. Stable Bun 1.4.2 miscompiles StyleX's CSS tokenizer, so the dev server answers 500 for some files, and `bun test` fails with a message that says so.

```sh
bun install
bun run dev
```

Open the URL printed by Vite (usually <http://localhost:5173>). Both `/` and `/d/$docId` are routed by TanStack Router.

The dev and preview servers listen on all interfaces and accept any `*.ts.net` host, so another device on your tailnet can open `http://<machine>.<tailnet>.ts.net:5173`. Over plain HTTP the phone share sheet is unavailable, so Export downloads the PNG instead.

## Quality gates

```sh
bun run check
bun test
bun run build
bun run perf --repeat 5
```

`bun run perf` is being implemented alongside the pixel core. It is not yet a passing gate.

Vite+ handles dev, build, Oxlint, and Oxfmt. Use `vp fmt` for formatting.

Features own their framework-free `core/`, React `ui/`, tests, and perf cases. Other features import only through each feature's `index.ts`.
