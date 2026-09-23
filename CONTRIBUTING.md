# Contributing to Fstop

Thanks for looking. Three project rules are non-negotiable, and they are enforced by CI — read them before opening a PR.

## Non-negotiable rules

1. **`src/core/` is hand-written.** The data model, the index state machine, the task queue and the two interfaces (`PhotoSource`, `EmbeddingProvider`) must be designed by a human and reviewed line by line. Tooling may help elsewhere; it may not generate `src/core/` for you.
2. **Every outbound request must be declared.** No telemetry, analytics, error reporting or third-party scripts. The only whitelisted egress point is `src/storage/models.ts` (model weight download). `scripts/check-egress.mjs` fails the build on any other use of `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` in `src/`, and on external origins in `index.html`.
3. **`src/core/` unit coverage ≥ 80 %.** Everything else is covered by end-to-end tests on the critical paths.

## AI policy

**AI-assisted contributions are welcome.** This is a deliberate, explicit choice, and it is the point where this project differs from some peers in the same space that ban AI-generated code outright.

The condition is not the tool, it is the author:

- You must be able to explain **any line you submit**, and say why it is there.
- `src/core/` and tests are equally open to AI assistance — the **review bar does not move**. Reviewers may ask you to explain an arbitrary line or to justify a design decision; "the model wrote it" is not an answer.
- If you cannot explain a change, do not submit it.

## Development

```bash
pnpm install
pnpm dev          # dev server
pnpm verify       # typecheck + lint + zero-egress check + unit tests
pnpm build        # typecheck + production build
```

Requirements: Node `>=22.22` (unit tests run the real SQLite schema through `node:sqlite`) and pnpm 11. Target runtime is **desktop Chromium only** (Chrome / Edge 86+); Firefox and Safari are out of scope by design — see the project plan in `docs/`.

## Workflow

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- `main` is protected. Work happens on `feature/*` branches and lands through pull requests.
- Every milestone ends with a git tag and a change note.

## Design source of truth

`docs/Fstop-光圈-项目计划-v0.2.md` (Chinese) is the design document. If a change contradicts it, update the plan in the same PR rather than letting the two drift.
