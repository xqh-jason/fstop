# Fstop

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![中文说明](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-blue)](README.zh-CN.md)

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

## Try it

Nothing to install, and no folder to hand over first — the build ships a sample library.

```bash
pnpm install
pnpm dev            # then open the printed localhost URL
```

Click **先试用内置样例** ("try the bundled samples") in the folder card: the app indexes 39 CC0/public-domain
photos that live in `public/samples/`, so you can see indexing, search, similar-photo grouping, the people
panel and the offline panel without granting access to your own library. Then pick your real folder.

Deployment is a static site. `pnpm build` emits a self-contained `dist/` (ONNX Runtime's wasm and the
SQLite wasm are bundled same-origin, model weights are fetched from the model origin at runtime and cached
by the browser) — serve it from any static host. `pnpm build && node bench/e2e-samples.mjs` verifies the
built artifact end to end: sample indexing, a search, and that no request leaves for a host other than the
model origin — including the app's own origin, which must never show up as a violation.

## Hard limits

| Property          | Target                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Photos copied     | **0 bytes**                                                                                                                                           |
| Outbound requests | **Zero beyond model weight downloads** — enforced by CI, not by eyeballing the network panel                                                          |
| Platform          | Desktop Chromium (Chrome / Edge **113+**, WebGPU required). Firefox and Safari lack the directory picker and WebGPU; mobile is out of scope by design |
| Core              | `src/core/` is hand-written and unit-tested; index and retrieval logic is meant to be read                                                            |

## Status

**M0 (feasibility), M1 (MVP) and M2 (differentiating features) are complete.** Scaffold, governance files,
the data model, the two core interfaces and the end-to-end pipeline (decode → embed → thumbnail → OPFS vector
matrix → SQLite) all work, "10k photos in 10 minutes" is measured rather than extrapolated, and Tauri-scale
performance work is the only thing left of M1's list. M3 (release form) landed too: a self-contained static
build, a bundled sample library so the app is usable before you hand over a folder, and a packaged release
artifact (`pnpm release` — the derived weights are stripped, see [`CHANGELOG.md`](CHANGELOG.md)).

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

**M2 (differentiating features) complete** — all four items landed and measured:

| M2 item                      | What it does                                                                                                                                 | Measured                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Similar / duplicate grouping | cosine threshold + union-find over the same vectors                                                                                          | 16 photos (8 originals + 1 copy each) → 8 groups of 2, **zero false merges**, 1 ms                                                        |
| Result ordering              | similarity / newest / oldest; EXIF `taken_at` first, falling back to `mtime`, and honestly labelled "unknown time" rather than inventing one | 5 ordering assertions in `bench/e2e-app.mjs`                                                                                              |
| Face clustering + naming     | SCRFD-34g detect → 5-point align → ArcFace 512-d → **complete-linkage** clustering; rename / merge / split in the UI                         | 7 labelled portraits → 7 faces → exactly 2 groups (4 + 3), **no mixed group**; same-person cosine 0.506–0.995 vs different-person ≤ 0.031 |
| Offline-capability panel     | records the requests the browser _actually_ makes, groups them by host, shows local storage/size, names any offending host in red            | 6 assertions in `bench/e2e-app.mjs`, one of them cross-checked against the test script's own request hook                                 |

Note the face models' licence: the recogniser (`antelopev2`, insightface family) is **non-commercial**.
Enabling faces therefore makes the whole project non-commercial — see `NOTICE` §2.

The people panel renders face crops at **≥100 px**, cropped by scaling the thumbnail so the face box fills the
cell and the face _centre_ lands on the cell centre (both are pure ratios, so they hold at any photo or
thumbnail size) — a 64 px cell and a corner-aligned crop were both reported as bugs by real use and are now
pinned by pixel-level assertions in `bench/e2e-faces.mjs`.

Details, including the numbers behind every claim on this page: [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md),
and the reasoning behind the architecture: [`docs/DESIGN.md`](docs/DESIGN.md).

## Documents

| File                                       | What it is                                                         |
| ------------------------------------------ | ------------------------------------------------------------------ |
| [`README.zh-CN.md`](README.zh-CN.md)       | 中文说明（内容与本文一致）                                         |
| [`docs/DESIGN.md`](docs/DESIGN.md)         | Architecture, the decisions and their alternatives, the invariants |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | Every measured number, how to reproduce it, and what it disproved  |
| [`CHANGELOG.md`](CHANGELOG.md)             | Release history                                                    |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)       | How to build, test and submit a change                             |
| [`SECURITY.md`](SECURITY.md)               | Threat model and how to report a vulnerability                     |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Contributor Covenant 2.1                                           |
| [`NOTICE`](NOTICE)                         | Model origins, licences and redistribution limits                  |

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

### 许可与使用限制（重要）

人脸功能（M2）使用的识别模型 `immich-app/antelopev2` 采用 **insightface 的 `license: other`（非商用研究用途）**。
这一条会传导到整个产品：**只要启用人脸识别，本项目就不得用于商业用途**。
检测模型 `immich-app/scrfd_34g_gnkps` 是 MIT，不构成限制。

界面（「人物」面板）与 `NOTICE` §2 都写明了这一点；若你需要商用，
可以只用检索与相似分组功能（不点「识别人脸」），或自行替换为许可允许的人脸模型。
