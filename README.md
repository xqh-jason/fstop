# Fstop

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Local semantic photo search that runs in your browser. Pick a folder, let your own device index it, then find any photo with a sentence — photos are never copied, never uploaded, nothing to install, and the core is readable line by line.**

Fstop is a search layer for a photo library you already have. It holds file handles, not copies. It runs a CLIP-family model on WebGPU inside a desktop Chromium tab and stores the index in the browser's own storage. There is no server, no account, no CUDA, no Docker, and no directory you have to move your photos into.

## How it differs from existing options

| Option                                                                     | Shape                                                     | Relation to Fstop                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MaterialSearch](https://github.com/chn-lee-yumi/MaterialSearch) (GPL-3.0) | Windows package / Docker + GPU, same default model family | Closest overlap. Two differences, and they are the whole point: (1) it needs an install, mounted paths and a capable GPU; (2) its core is closed — the API implementation is not open source and the frontend is deliberately obfuscated. |
| [Immich](https://github.com/immich-app/immich)                             | Self-hosted server                                        | Needs a server. Data stays on your network, but you still operate and deploy a machine.                                                                                                                                                   |
| [PhotoPrism](https://github.com/photoprism/photoprism)                     | Self-hosted server                                        | Same as above.                                                                                                                                                                                                                            |
| [rollfilm](https://github.com/pasqualkreher/rollfilm) (MIT, Electron)      | Desktop shell, privacy-first, RAW aware                   | Same shape, Electron route. Evidence that a desktop shell plus RAW support is wanted.                                                                                                                                                     |
| semantic-file-explorer / CLIP-Finder2                                      | Swift / macOS native                                      | Single platform, single ecosystem.                                                                                                                                                                                                        |

**Performance is not this project's battlefield.** A CUDA box will always win. Fstop bets on three other things: **zero install, zero copies, auditable core.** So the hard limits below are not about speed.

## Hard limits

| Property          | Target                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Photos copied     | **0 bytes**                                                                                                          |
| Outbound requests | **Zero beyond model weight downloads** — enforced by CI, not by eyeballing the network panel                         |
| Platform          | Desktop Chromium (Chrome / Edge 86+). Firefox and Safari lack the directory picker; mobile is out of scope by design |
| Core              | `src/core/` is hand-written and unit-tested; index and retrieval logic is meant to be read                           |

## Status

**M0 (feasibility) complete.** Scaffold, governance files, the data model, the two core interfaces and the
end-to-end indexing pipeline (decode → embed → thumbnail → OPFS vector matrix → SQLite) all work; the five
M0 measurements are in. M1 (MVP) is in progress: the "10k photos in 10 minutes" item has landed and been measured.

Measured on an M2 / Chrome 153: 783 real CC0 photos indexed at **13.6 photos/s → 10k extrapolates to 12.3 min**
(acceptance line 20 min, sprint target 10 min), search latency 78 ms (budget 300 ms), Chinese-query retrieval
**R@1 = 100%** with the default Chinese-CLIP (an English-only CLIP collapses to 13% on the same queries), HEIC
is **not** decodable in Chromium, and `opfs-sahpool` needs Web Locks leader election.

Two M0-closeout findings that reset the first M1 decision: **ONNX Runtime's WebGPU EP does not prune unused
outputs** (naming `image_embeds` as the only fetch returns one tensor but takes the same 59 ms as the full run),
and the single-image cost is **~97% vision tower** — the "wasted text tower" that the earlier numbers blamed for
59% of embed time is really ~0.5 ms, because the placeholder text fed during indexing is two tokens.

The M1 decision is now settled, and it is **not** a cheaper backbone. The resolution lock turned out to be three
constants (a `[1,197,768]` positional embedding, 96 Reshape constants, plus 667 stale `value_info` shape
annotations that `extract_model` copies along), and rewriting all three makes the same weights run at any
`(n²+1)` token count. The re-exported **192² (145-token) single tower** is now wired into the product path
(`src/workers/embed.worker.ts` picks it up when the locally generated artifacts are present, and falls back to
the stock dual-tower path when they are not — no Python, still works, just slower). Same-corpus A/B, one
variable changed:

| embed path                         | photos/s  | 10k photos  | embed median | text query | first-load weights |
| ---------------------------------- | --------- | ----------- | ------------ | ---------- | ------------------ |
| stock dual tower @224²             | 13.49     | 12.4 min    | 172 ms       | 69 ms      | 131.8 MB           |
| **re-exported single tower @192²** | **18.56** | **9.0 min** | **113 ms**   | **28 ms**  | **47.5 MB**        |

**The 10-minute sprint line is met, measured rather than extrapolated.** The derived artifacts are weights
(a rewrite of weights whose upstream model card declares no license), so they are generated locally by
`bench/export-towers.py --deploy 192`, served from a gitignored directory, and never redistributed.

And the quality cost of that speed, measured **through the product path** on the same 783-photo gallery with
106 Chinese queries (one variable changed): zh R@1 **48.1% → 46.2%**, with 7 queries hit only by the stock path
and 5 only by the derived one — a paired McNemar exact test gives **p = 0.774**, i.e. not measurable. English:
38.7% → 34.9%, p = 0.424. The stock baseline reproduced the earlier spike-page measurement digit for digit,
which is what makes the comparison trustworthy.

Which resolution, and why not the cheaper one: on the 39-photo sample set **160²** looked free (R@1 still
100%), but that sample cannot tell 100% from 87%. Re-running on a **783-photo gallery with 106 Chinese queries**
(queries transcribed from the Commons uploaders' own titles, never from looking at the images) shows 160²
loses **−9.4 pp R@1 (p = 0.021)**, while 208²/192²/176² are statistically indistinguishable from 224²
(p = 0.51/0.34/0.15) — so **192² is the largest reduction whose quality loss is not measurable**, and 160²
stays available as a fast mode. A dtype comparison (same page, same inputs, one variable) shows **fp16 is
13–16% faster than q4f16** but 3.5× the bytes, so q4f16 stays the default.

One violation came out of the M1 wiring: `@huggingface/transformers` defaults ONNX Runtime's `wasmPaths` to a
**jsdelivr CDN**, so a cold first visit really did fetch a 25.6 MB wasm runtime from a third party (found by
grepping the bench profile's CacheStorage for the CDN URL — hot caches hide it, because it then comes from the
Cache API and produces no network request at all). It is now pinned to a same-origin asset, and `bench/runner.mjs`
asserts **zero external requests other than the model origin** at runtime, failing the run with a non-zero exit
code otherwise. The static egress check cannot see inside dependencies; this is the second gate.

Details: `docs/Fstop-光圈-M0-实测记录.md` §9 (the M1 landing is §9.10).

Documents, in reading order:

| File                               | What it is                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `docs/Fstop-光圈-项目计划-v0.2.md` | The design source of truth (Chinese): scope, stack, milestones, metrics, DoD |
| `docs/Fstop-光圈-M0-实测记录.md`   | M0 measurements and the four places they contradict the plan                 |
| `docs/Fstop-光圈-交接说明.md`      | Handoff: current state, environment facts, known traps, next steps           |

Pre-1.0: expect `src/core/` to move.

## Development

```bash
pnpm install
pnpm dev          # dev server
pnpm verify       # typecheck + lint + zero-egress check + unit tests
pnpm build        # typecheck + production build
```

Node `>=22.22` (unit tests use `node:sqlite` to run the real schema), pnpm 11. See `CONTRIBUTING.md` for the three non-negotiable rules.

## Licence

Code: **MIT** (`LICENSE`). Model weights are **not** redistributed by this repository — origins, licences and the reasoning are recorded in `NOTICE`.
