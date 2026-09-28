# Design

Why Fstop is built the way it is. Numbers live in [`BENCHMARKS.md`](BENCHMARKS.md); every claim there is
reproducible with the scripts in `bench/`.

## What it is, and what it is not

Fstop is a **search layer** for a photo library you already have. It holds file handles, runs a CLIP-family
model on WebGPU inside a Chromium tab, and stores the index in the browser's own storage.

- **Not** a photo manager: no import step, no library database it owns, no editing, no albums.
- **Not** a server: no Docker, no account, no port to expose.
- **Not** a speed project: a CUDA box will always win. The bets are zero install, zero copies, and an
  auditable core.

## Subsystems

| Path           | Responsibility                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/core/`    | Hand-written, framework-free logic: data model, content hashing, scan planning, task queue, the two interfaces. This is the part meant to be read. |
| `src/app/`     | Orchestration in the page: index runner, face runner, wall layout, thumbnail cache, result ordering.                  |
| `src/storage/` | Persistence: OPFS directories, the `opfs-sahpool` SQLite layer, migrations, the flat vector matrix, model registry.   |
| `src/workers/` | Inference and decode: `embed.worker` (CLIP), `face.worker` (detect → align → recognise), shared pre-processing, ONNX Runtime bootstrap. |
| `src/ui/`      | Vue components: the shell, photo wall, similar groups, people panel, offline panel.                                   |
| `bench/`       | Browser-driven benchmarks and end-to-end scripts (`runner.mjs` for throughput/quality, `e2e-*.mjs` for behaviour).     |

## Pipelines

**Index** — `select folder` → `PhotoSource` (File System Access handles) → decode (EXIF orientation applied,
downsampled) → embed (WebGPU, single tower) → thumbnail (320 px, q0.8) → append to the flat vector matrix in
OPFS → rows in SQLite (queue, photos, vectors). Tasks are claimed in batches and completed idempotently, so
closing the tab mid-run loses nothing but time.

**Search** — text → encoder → cosine over the vector matrix (read whole, sorted in memory) → rows from SQLite
for display. The index is searchable while it is still being built, because the matrix is append-only and
partially-written state is self-consistent.

**Faces** — a separate worker chain: SCRFD detect → 5-point alignment → ArcFace embedding (512-d) → clustering
with complete-linkage constraints plus iterative refinement. Face vectors live in their own space
(`face-arcface-r100`), so switching the photo model never invalidates them.

## Decisions and their alternatives

| Decision                                   | Alternative                          | Why not the alternative                                                                                        |
| ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **File handles** (File System Access)      | Upload / copy into an app folder     | The promise is "photos are never copied". Handles `read()` raw bytes on demand.                                |
| **Flat Float32 matrix**, sequential append | One row per vector in IndexedDB; HNSW | 10k × 512 × 4 B ≈ 20 MB; a whole-matrix cosine sort is milliseconds. HNSW is over-engineering at this size.     |
| **Self-managed SQLite** (`opfs-sahpool`)   | JSON in OPFS / IndexedDB             | Transactions, incremental rescans, a job queue and crash recovery are needed. The VFS allows one instance per origin, hence Web Locks leader election: a second tab degrades to read-only rather than failing. |
| **Re-exported 192² single tower**          | Stock dual tower                     | Per-image cost is ~97 % the vision tower; the "wasted text tower" figure was a cross-model artefact. Re-exporting keeps the same weights and drops the resolution lock. |
| **Searchable during indexing**             | Lock search until indexing finishes  | Costs a matrix re-read per query (a few milliseconds), buys "usable immediately".                              |
| **One decode budget per purpose**          | Share the photo decode for faces     | 512 px was tuned for CLIP; faces need their own (`FACE_DECODE_SIDE = 1280`) or small faces are lost.           |

## Invariants

These hold in every change; the egress checker, the unit tests and the end-to-end scripts enforce them.

1. `src/core/` is hand-written and line-by-line explainable.
2. **Every outbound request is declared.** The only whitelisted egress is model weight download
   (`src/storage/models.ts`). No telemetry, analytics, error reporting or third-party scripts — including
   pointing ONNX Runtime's `wasmPaths` at a CDN.
3. Derived model weights are **generated locally and never redistributed** (`public/models/derived/` is
   gitignored; release packaging refuses any artifact containing an `.onnx`).
4. **One semantic, one implementation** — extension tables, query matching, pre-processing and HTTP photo
   sources each exist exactly once.
5. No cross-model attribution: cost and quality comparisons are single-variable, same model.
6. Never open two `opfs-sahpool` instances; `mtime + size` is not an identity.
7. When a test fixture is wrong, fix the fixture, not the algorithm.
8. Never ship a UI change without a pixel-level assertion.

## Pre-1.0 note

`src/core/` is expected to move. Treat the module layout as a snapshot, not a contract; the interfaces
(`PhotoSource`, `EmbeddingProvider`) are the parts meant to be stable.
