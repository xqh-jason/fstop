## What and why

<!-- What changes, and the reason for it. "Why" beats "what" in review. -->

## Checks

- [ ] `pnpm verify` passes (unit tests, lint, typecheck, egress assertion)
- [ ] Behaviour changed → the matching `bench/e2e-*.mjs` script was run, and its output is in the PR
- [ ] UI changed → a **pixel-level** assertion was added (size, aspect, crop content), not only a data assertion
- [ ] No new outbound request outside the model-origin whitelist in `src/storage/models.ts`
- [ ] No derived model weight (`.onnx`) added to the repository
- [ ] `docs/BENCHMARKS.md` updated if a number in the README or a comment changed
