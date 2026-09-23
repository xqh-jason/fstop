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

**Initialized.** Scaffold, governance files, data model and the two core interfaces are in place. No indexing or retrieval code yet — those land in M0/M1. Pre-1.0: expect `src/core/` to move.

The Chinese project plan (`docs/Fstop-光圈-项目计划-v0.2.md`) is the design source of truth: milestones, acceptance numbers, licence matrix and the reasoning behind each decision.

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
