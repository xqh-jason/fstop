# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Chinese README** ([`README.zh-CN.md`](README.zh-CN.md)), plus the governance files an open-source release
  needs: `CHANGELOG.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `.github/` issue / pull-request templates.
- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture, the decisions and their alternatives, and the invariants.
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — every measured number, the environment it was taken in, and the
  commands that reproduce it.
- `bench/shots.mjs` — takes the release screenshots from the **built artifact**, so the pictures match what
  someone actually downloads.

### Changed

- Documentation restructured to open-source conventions: the internal handoff notes, project plan and
  measurement logs are gone; comments that referenced them now point at `docs/DESIGN.md` or
  `docs/BENCHMARKS.md`, and `CONTRIBUTING.md` names those two as the source of truth.

## [0.3.0] - 2026-09-28

Everything measured in this release is reproducible with the scripts in `bench/`; see
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) for the numbers and the environment they were taken in.

### Added

- **Local semantic search** — folder handles instead of copies, CLIP-family embeddings on WebGPU, a flat
  Float32 vector matrix plus SQLite in OPFS, searchable while indexing.
- **Similar / duplicate photo grouping** — threshold clustering with complete-linkage constraints.
- **Result ordering** — similarity / newest / oldest, with EXIF `taken_at` first, file time as fallback, and
  "unknown time" stated as such instead of invented.
- **Face clustering and naming** — SCRFD detect → 5-point alignment → ArcFace 512-d → constrained clustering;
  rename / merge / split in the UI, and names survive recomputation.
- **Offline-capability panel** — records the requests the browser actually makes, groups them by host, shows
  local storage usage and names any offending host in red.
- **Bundled sample library** — 39 CC0 / public-domain photos in `public/samples/`, so the app is usable before
  handing over a folder ("先试用内置样例").
- **Static release form** — `pnpm build` emits a self-contained `dist/` (ONNX Runtime and SQLite wasm bundled
  same-origin, model weights fetched from the model origin at runtime), verified by `bench/e2e-samples.mjs`.
- **Release packaging** (`pnpm release:package`) — strips derived model weights, fails if any `.onnx` reaches
  the artifact, and writes `SHA256SUMS` + `RELEASE.txt`.
- **Multi-tab leader election** — a second tab degrades to read-only instead of failing.
- **Virtualised photo wall** — ten-thousand-photo scale, with an LRU thumbnail cache that revokes object URLs.

### Changed

- People panel: face cells are now at least **100 px** (were 64 px) and the layout fills the window width;
  an expanded group spans the full row.
- Photo/library container widened from `46rem` to `108rem`, so the wall and the people panel use the screen.

### Fixed

- **People panel showed blank covers** — the thumbnail map for search results replaced the whole map (and thus
  evicted the face keys the people panel had just added); face covers now live in their own map, with
  `revokeObjectURL` on refresh.
- **People panel crops were 12.5× over-zoomed** — the zoom factor was computed in original-photo pixels and
  applied to a 320 px thumbnail, so a cell showed a flat patch of skin. All sizing is now unit-less ratios
  multiplied by container size in `calc()`.
- **Crops drifted off the face** — the crop aligned the face box's top-left corner and dropped the photo aspect
  factor; it now aligns the face _centre_ to the cell centre (`--sw` / `--fx` / `--fy`), which holds at any
  photo, thumbnail or cell size.
- **Deployed builds flagged their own origin as external egress** — the egress ledger classified by host
  allow-list only; same-origin requests are now classified as local, so the offline panel stops crying wolf.
- Face pipeline: normalisation scale (`mean`/`std = 0.5`, not `127.5`), a face-specific decode side (1280 px
  instead of CLIP's 512), a per-photo delete that silently dropped all but the last face of each photo, and
  centroid-linkage clustering that merged two different people (now complete-linkage plus refinement).

[Unreleased]: https://github.com/xqh-jason/fstop/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/xqh-jason/fstop/releases/tag/v0.3.0
