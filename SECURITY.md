# Security

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(_Security → Report a vulnerability_). Please do not open a public issue for anything that could put users at
risk before there is a fix.

Useful in a report: affected version or commit, what you did, what happened, and — if you can — the smallest
reproduction you have. Expect an acknowledgement within a few days; this is a spare-time project, so a fix may
take longer than a commercial SLA. You will be credited in the release notes unless you ask not to be.

## What this project is, in threat-model terms

Fstop is a **static site with no server component**. It has no accounts, no database behind an API, and no
telemetry. That removes whole classes of issues (auth bypass, server-side injection, data-at-rest on someone
else's disk) and concentrates the remaining risk in three places:

1. **Outbound requests.** "Zero requests beyond the model origin" is a promise the project makes in public.
   Anything that causes a request to an undeclared host — including a dependency reaching for a CDN — is a
   security bug here. It is checked statically (`scripts/check-egress.mjs`, run by CI) and at runtime (the
   `bench/e2e-*.mjs` scripts fail the run on any such request).
2. **Dependencies and model weights.** The app executes ONNX Runtime wasm and model files in the page. A
   malicious or substituted weight file, or a compromised dependency, is the realistic supply-chain path.
   Weights are pinned by URL, size and SHA-256 in `public/models/manifest.json`.
3. **Local data handling.** Photos are read through file handles and never copied; the index lives in the
   browser's storage for that origin. Reports about data leaking _out_ of the page, or about the app writing
   outside its own origin's storage, are in scope.

## Explicitly out of scope

- Model _quality_ (a face grouped wrongly, a search that misses) — that is a bug, please file a normal issue.
- Missing features that were deliberately excluded: HEIC/RAW decoding, mobile browsers, Firefox/Safari.
- Anything that requires the user to install a malicious extension or run a modified build.

## For contributors

`pnpm verify` (CI runs the same) enforces the egress allow-list, type-checks, lints and runs the unit tests.
If your change touches network access, storage layout or model loading, say so in the pull request — that is
where review effort goes.
