# Benchmarks

Every number in the README comes from a script in `bench/` and is reproducible. **Quote the environment with
the number**: the browser build moves these figures more than any code change does.

## How to measure

```bash
node bench/runner.mjs --m0        # five M0 unknowns: adapter, decode, throughput, HEIC, identity
node bench/runner.mjs --run       # corpus → decode → embed → thumbnail → DB, photos/s
node bench/runner.mjs --query     # query latency (budget: ≤ 300 ms)
node bench/runner.mjs --quality   # synthetic + real-corpus recall
node bench/e2e-app.mjs            # end-to-end behaviour on the product page
node bench/e2e-samples.mjs        # end-to-end on the built artifact (static hosting path)
```

**Reference environment for every figure below** — quote it whenever you quote a number:

|                  |                                                                          |
| ---------------- | ------------------------------------------------------------------------ |
| Machine          | Apple M2 (MacBook Air), macOS 27                                         |
| Browser          | system **Chrome 153.0.0.0**, headless, driven by Playwright (`pnpm bench`) |
| Corpus           | 783 real CC0 photos from Wikimedia Commons (1.71 GB) + a 200-photo synthetic corpus |
| Storage / network | local SSD; model weights cached after the first run                     |

A second environment (a separately managed Chromium build) produced 4.38 photos/s where this one produced
9.96 for the same configuration — **that environment's absolute numbers are never quoted**.

## M0 — the five unknowns

| Question                                           | Measured                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Is WebGPU usable in a browser tab?                 | Yes. `adapter.info` comes back empty, so software rasterisation cannot be detected from it — the check reads the WebGL renderer name instead (`ANGLE Metal Renderer: Apple M2` vs `SwiftShader` / `llvmpipe`) and refuses to benchmark a software adapter. |
| Can a 12 MP JPEG be decoded fast enough?           | Median 41–47 ms per image, EXIF orientation applied, downsampled on the way. |
| What throughput does end-to-end indexing reach?    | 12.04 photos/s on the 200-photo synthetic corpus at M0 (embed 176 ms + decode 41 ms per photo → 10,000 photos ≈13.8 min). The shipped pipeline is faster — see the A/B table below. |
| Do HEIC/HEIF files decode in the browser?          | **No** — Chromium cannot decode HEIC. The extension list still counts them, and each one lands in `skipped` with a visible reason instead of silently vanishing. |
| Is `mtime + size` good enough as a photo identity? | No. A backup restore or a folder move changes every `mtime`; identity is `size` + a hash of the first and last 64 KB, so moved photos are never re-embedded. |

## Throughput and latency

Same 783-photo gallery, one variable changed (the embed path):

| embed path                         | photos/s  | 10,000 photos | embed median | text query | first-load weights |
| ---------------------------------- | --------- | ------------- | ------------ | ---------- | ------------------ |
| stock dual tower @224²             | 13.49     | 12.4 min      | 172 ms       | 69 ms      | 131.8 MB           |
| **re-exported single tower @192²** | **18.56** | **9.0 min**   | **113 ms**   | **28 ms**  | **47.5 MB**        |

Supporting measurements:

| Metric                               | Measured                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| Per-stage median, real corpus        | read 4 ms · hash 1 ms · decode 47 ms · **embed 154 ms** · thumbnail 2 ms      |
| Single-image compute floor           | 68 ms, 60 ms of it inside ONNX Runtime, serialised (one GPU session)          |
| Query latency, M0 dual tower         | 78.1 ms = 70.8 ms text + 7.3 ms cosine top-k over 10,000 × 512 vectors        |
| Query latency, shipped single tower  | ≈27 ms (text encode + retrieval)                                             |
| First run (cold cache)               | 131.8 MB of weights; 67.2 s session init observed on a 0.45 MB/s link         |

## Retrieval quality

### Small set: 39 CC0 samples, 23 Chinese queries

| Model                                   | zh R@1 | zh R@5 | zh R@10 | zh MRR | en R@1 |
| --------------------------------------- | ------ | ------ | ------- | ------ | ------ |
| Chinese-CLIP ViT-B/16 (shipped)         | 100%   | 100%   | 100%    | 1.000  | 100%   |
| CLIP ViT-B/32, English-only single tower | 13%    | —      | —       | —      | 100%   |

Random top-1 over 39 photos is ≈5%, so 100% is not a high bar — this set can tell 100% from 87%, and nothing
finer. It is kept because it is fast and because it is the set where the English-only model visibly collapses.

### Real set: 783 photos, 106 Chinese queries, through the product path

Queries were transcribed from the Commons uploaders' own titles, never from looking at the images.

| Comparison                     | Result                                                          |
| ------------------------------ | --------------------------------------------------------------- |
| zh R@1, stock vs 192² derived  | 48.1% → 46.2% (7 queries only stock, 5 only derived; McNemar exact **p = 0.774**) |
| en R@1, stock vs 192² derived  | 38.7% → 34.9% (**p = 0.424**)                                   |
| zh R@1, stock vs 160²          | 48.1% → 38.7%, **−9.4 pp (p = 0.021)** — 160² is *not* free     |
| 208² / 192² / 176² vs 224²     | statistically indistinguishable — see below for why 192² won    |

The stock path reproduced the spike-page measurement digit for digit, which is what makes the comparison
trustworthy. The resolution choice therefore comes down to cost: 192² is the smallest tower that does not
measurably lose quality, and it is the one the product loads.

**Never compare cost or quality across two different models.** The "text tower is 59% of the cost" claim in
early notes compared Chinese-CLIP ViT-B/16 against CLIP ViT-B/32; within one model the text tower is ≈0.5 ms
for the two-token placeholder used during indexing.

## Feature-level measurements

| Feature                       | Measured                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Similar-photo grouping        | 16 photos → 8 groups of 2, zero false absorptions, 1 ms                                       |
| Face clustering separability  | Same person 0.506–0.995 (median 0.882); different people −0.026–0.031; shipped threshold 0.45 |
| Face pipeline cost            | Detector load 9.9 s, recogniser load 63.2 s (248.6 MB), per-photo analysis 831 ms (804 ms detect) |
| People panel rendering        | Faces 129–136 px wide at a 1512 px viewport; visible crop centred on the face, Δ 0.0 px        |
| Offline panel                 | Host ledger shows only the page's own origin (98 local requests, 0 external)                  |
| Release artifact              | 37 MB, 0 `.onnx` files, 39 sample photos, `SHA256SUMS` verified                               |

## Measurements that contradicted the plan

Kept because they are the reason several decisions read the way they do.

- **"The text tower is 59% of embed time"** — a cross-model artefact. Same model, same input: the vision tower
  is ≈97% of image encoding, and ONNX Runtime's WebGPU EP does **not** prune unused outputs (asking for one
  tensor costs the same 59 ms as the full run).
- **The resolution ablation was broken at first.** 224²/160²/112² all measured ~60 ms because the processor
  re-scaled every input back to 224 — the independent variable never moved. Reading `preprocessor_config.json`
  directly is what made the ablation real.
- **The face pipeline's first run scored zero detections** (max confidence 0.014): the pre-processing divided
  by 255 and then applied ArcFace's mean/std, so `(v − 127.5) / 127.5` had to be expressed as mean 0.5 / std 0.5.
  Wrong pre-processing collapses the input to a constant.
- **Clustering by centroid alone snowballs.** Two dissimilar faces whose centroid sits at ≈0.707 similarity to
  both absorb every later face at a 0.45 threshold. Complete-linkage constraints fix it.
- **Face covers rendered as flat colour while every data-level assertion passed** — twice, from two independent
  rendering bugs (one thumbnail map with two writers; a zoom factor computed in source pixels and applied to a
  320 px thumbnail). Hence the pixel-level assertions in `bench/e2e-faces.mjs`.

## Caveats

- Figures are from one machine and one browser build. Re-measure before quoting them anywhere else.
- The 39-photo quality set is small: differences below ~2 queries are noise.
- The 260.7 MB face recogniser is **non-commercial** (see `NOTICE`); the clustering tests use a 7-photo corpus
  of public-domain portraits.
