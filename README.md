# Fstop

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![中文说明](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-blue)](README.zh-CN.md)

**Local semantic photo search that runs in your browser. Pick a folder, let your own device index it, then find any photo with a sentence — photos are never copied, never uploaded, nothing to install, and the core is readable line by line.**

Fstop is a search layer for a photo library you already have. It holds file handles, not copies. It runs a
CLIP-family model on WebGPU inside a desktop Chromium tab and stores the index in the browser's own storage.
There is no server, no account, no CUDA, no Docker, and no directory you have to move your photos into.

Performance is not this project's battlefield — a CUDA box will always win. Fstop bets on three other things:
**zero install, zero copies, auditable core.**

## Try it

**<https://xqh-jason.github.io/fstop/>** — nothing to install, and no folder to hand over first.

Click **先试用内置样例** ("try the bundled samples") in the folder card and the app indexes 39 CC0 /
public-domain photos in your own browser, so you can see search, similar-photo grouping, the people panel and
the offline panel before granting access to anything. Then pick your real folder.

The first visit downloads 131.8 MB of model weights once (browser-cached afterwards). Everything else — the
index, the thumbnails, the face clustering — happens on your machine.

## Screenshots

| Indexing                                   | Search results                         |
| ------------------------------------------ | -------------------------------------- |
| ![Indexing](docs/screenshots/indexing.png) | ![Search](docs/screenshots/search.jpg) |

| The photo wall, full window width        | The offline-capability panel                   |
| ---------------------------------------- | ---------------------------------------------- |
| ![Photo wall](docs/screenshots/wall.jpg) | ![Offline panel](docs/screenshots/offline.png) |

## Hard limits

| Property          | Target                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Photos copied     | **0 bytes**                                                                                                                                           |
| Outbound requests | **Zero beyond model weight downloads** — the only host ever contacted is the model origin                                                             |
| Platform          | Desktop Chromium (Chrome / Edge **113+**, WebGPU required). Firefox and Safari lack the directory picker and WebGPU; mobile is out of scope by design |
| Core              | `src/core/` is hand-written and meant to be read                                                                                                      |

## Status and measurements

Search, similar-photo grouping, ordering, face clustering with naming, the offline-capability panel and the
bundled sample library all work. Every figure below was measured on an Apple M2 / Chrome 153 over a **783-photo
library of real CC0 photos**, and the commands that reproduce them are in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

| What                       | Measured                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Indexing throughput        | 13.5 photos/s (10,000 photos ≈ 12.4 min); **18.6 photos/s (≈ 9.0 min)** with the re-exported single tower                |
| Search latency             | 78 ms → **28 ms** with the single tower (budget: 300 ms)                                                                 |
| Chinese query quality      | R@1 **48.1% → 46.2%** between the two paths — statistically indistinguishable (paired McNemar p = 0.77)                  |
| Why not a smaller model    | 160² loses **9.4 pp** R@1 (p = 0.021), so 192² is the largest reduction whose quality loss is not measurable             |
| Similar / duplicate photos | 16 photos (8 originals + a copy of each) → 8 groups of 2, no false merges                                                |
| Faces                      | 7 labelled portraits → exactly 2 groups (4 + 3), no mixed group; same-person cosine 0.506–0.995 vs ≤ 0.031 across people |
| Face crops                 | rendered at ≥ 100 px, cropped so the face _centre_ lands on the cell centre                                              |

First load downloads 131.8 MB of weights (47.5 MB with the locally generated single tower). The index lives in
this browser's storage for this site — it is per browser, not per account, and clearing site data removes it.

## Known limits

- **HEIC / RAW are out of scope**: Chromium cannot decode them. Such files are counted and reported as skipped
  with a visible reason rather than silently disappearing.
- **Closing the tab stops indexing**: an inherent property of the browser route; background indexing would need
  a native shell.
- **The face recogniser is non-commercial**, which propagates to the whole project while faces are enabled —
  see below.
- **Face corpus is small**: 7 portraits of 2 people prove "no mixing, same person groups together", but give no
  recall/precision figure.

## Licence

Code: **MIT** ([`LICENSE`](LICENSE)). Model weights are **not** redistributed by this repository — origins,
licences and the reasoning are recorded in [`NOTICE`](NOTICE).

Enabling face recognition makes the project **non-commercial**: the recogniser (`immich-app/antelopev2`) is
under insightface's `license: other` (non-commercial research use). The detector (`immich-app/scrfd_34g_gnkps`)
is MIT and does not restrict anything. If you need commercial use, use search and similar-photo grouping only
(don't enable faces), or swap in a face model whose licence allows it.

## Documents

| File                                       | What it is                                                         |
| ------------------------------------------ | ------------------------------------------------------------------ |
| [`README.zh-CN.md`](README.zh-CN.md)       | 中文说明（内容与本文一致）                                         |
| [`docs/DESIGN.md`](docs/DESIGN.md)         | Architecture, the decisions and their alternatives, the invariants |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | Every measured number and how to reproduce it                      |
| [`CHANGELOG.md`](CHANGELOG.md)             | Release history                                                    |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)       | How to contribute                                                  |
| [`SECURITY.md`](SECURITY.md)               | Threat model and how to report a vulnerability                     |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Contributor Covenant 2.1                                           |
| [`NOTICE`](NOTICE)                         | Model origins, licences and redistribution limits                  |
