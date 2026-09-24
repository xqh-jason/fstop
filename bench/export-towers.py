#!/usr/bin/env python3
"""
拆塔 / 降分辨率导出的 spike 工具 —— 交接说明 §9A5 与 §9B 的 D2。

背景：`Xenova/chinese-clip-vit-base-patch16` 是单文件双塔，且 ORT 的 WebGPU EP
**不剪枝**（实测记录 §9.1），所以要真正只算视觉塔，只能从 ONNX 图里**切出子图**。
本脚本用 `onnx.utils.extract_model` 做图手术，产出：

  vision<size>_q4f16.onnx   pixel_values -> image_embeds（多个分辨率档）
  text_q4f16.onnx           input_ids+attention_mask -> text_embeds

**「分辨率被导出钉死」的完整机制**（实测记录 §9.3 只查到第一道闸）：

1. 位置编码是常量初始化器 `[1, 197, 768]` —— 输入边长一变，`/vision_model/embeddings/Add`
   就报 `left operand cannot broadcast`；
2. 就算把位置编码改成目标 token 数，编码器里还有 **96 个写死 197 的 Reshape 常量**
   （12 层 × 8 个），ORT 建会话时直接 `[ShapeInferenceError] Incompatible dimensions`；
3. 还有第三个更隐蔽的坑：`extract_model` 会把源图的 **667 条 `value_info` 形状注解**
   一起复制出来，注解里写死 197 —— 改完前两块**仍然**报同一个 Add 不兼容，必须清空注解。

三块的完整排查过程见实测记录 §9.5。

派生产物落在 `bench/export/`（已 gitignore，与 `.cache/models` 同一纪律：仓库不分发权重）。
Python + `onnx` 属于 spike 期的一次性依赖，不是项目运行依赖。

用法：
  python3 bench/export-towers.py                 # 全部产出（默认 224/160/112/64 四档）
  python3 bench/export-towers.py --sizes 224 112
  python3 bench/export-towers.py --inspect       # 只打印图结构
"""

import argparse
import hashlib
import json
import pathlib
import sys

import numpy as np
import onnx
from onnx import numpy_helper

ROOT = pathlib.Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / ".cache" / "models" / "chinese-clip-vit-b16"
OUT_DIR = ROOT / "bench" / "export"
# app 探测的部署目录（vite 服务 public/ 下的静态文件；目录 gitignore，权重永不入库）
DERIVED_DIR = ROOT / "public" / "models" / "derived"

VISION_IN, VISION_OUT = "pixel_values", "image_embeds"
TEXT_IN, TEXT_OUT = ["input_ids", "attention_mask"], "text_embeds"

PATCH = 16  # preprocessor_config.json：size 224 / patch 16
BASE_SIZE = 224
BASE_TOKENS = (BASE_SIZE // PATCH) ** 2 + 1  # 197


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def describe(model: "onnx.ModelProto") -> None:
    print("inputs :", [item.name for item in model.graph.input])
    print("outputs:", [item.name for item in model.graph.output])
    print(f"nodes  : {len(model.graph.node)}  initializers: {len(model.graph.initializer)}")
    names = {item.name for item in model.graph.initializer}
    shape_constants = 0
    layers = set()
    for node in model.graph.node:
        if node.op_type != "Reshape":
            continue
        for name in node.input:
            if name not in names:
                continue
            item = next(i for i in model.graph.initializer if i.name == name)
            values = [abs(int(value)) for value in numpy_helper.to_array(item).flatten()]
            if BASE_TOKENS in values:
                shape_constants += 1
                pieces = node.name.split("/layers.")
                if len(pieces) > 1:
                    layers.add(pieces[1].split("/")[0])
    print(f"写死 {BASE_TOKENS} 的 Reshape 常量：{shape_constants} 个，分布在 {len(layers)} 层")
    for item in model.graph.initializer:
        if list(item.dims) in ([BASE_TOKENS, 768], [1, BASE_TOKENS, 768]):
            print(f"位置编码常量：{item.name} {list(item.dims)}")


def interpolate_positions(weights: np.ndarray, grid_from: int, grid_to: int) -> np.ndarray:
    """(1+from², dim) → (1+to², dim)：CLS 行原样保留，patch 网格做双线性插值。"""
    cls, patches = weights[0:1], weights[1:]
    dim = patches.shape[1]
    src = patches.reshape(grid_from, grid_from, dim)
    scale = grid_from / grid_to
    coords = (np.arange(grid_to) + 0.5) * scale - 0.5
    low = np.clip(np.floor(coords).astype(int), 0, grid_from - 1)
    high = np.clip(low + 1, 0, grid_from - 1)
    weight_x = np.clip(coords - low, 0.0, 1.0)[:, None]
    rows = src[low] * (1 - weight_x[..., None]) + src[high] * weight_x[..., None]
    weight_y = np.clip(coords - low, 0.0, 1.0)[:, None]
    out = rows[:, low, :] * (1 - weight_y[..., None]) + rows[:, high, :] * weight_y[..., None]
    return np.concatenate([cls, out.reshape(grid_to * grid_to, dim)], axis=0).astype(weights.dtype)


def rewrite_position_ids(model: "onnx.ModelProto", tokens: int) -> int:
    """把位置 id 常量 `arange(197)` 改写成 `arange(tokens)`。

    q4f16 那份导出里位置编码已被常量折叠成 `Gather_output_0` 大张量（只有一处要改）；
    **fp16 那份没有折叠**，位置编码是 `Gather(weight, position_ids)`，其中 `position_ids`
    是 `Constant` 节点里的 int64 `[1, 197]`。只改权重表会让 Gather 越界：
    ORT 报 `Gather: indices element out of data bounds, idx=101 must be within [-101,100]`，
    随后 Add 直接广播失败——**这是 D3 第一次跑 fp16 时的真实现象**，所以这一路必须一起改。

    只认「值恰好是 0..196 的等差序列」的整型常量，避免误改别的索引数组。
    """
    expected = list(range(BASE_TOKENS))
    target = np.arange(tokens, dtype=np.int64)
    changed = 0

    for item in list(model.graph.initializer):
        values = numpy_helper.to_array(item)
        if values.dtype.kind not in "iu" or values.size != BASE_TOKENS:
            continue
        if values.flatten().tolist() != expected:
            continue
        shape = (1, tokens) if values.ndim > 1 else (tokens,)
        item.CopyFrom(numpy_helper.from_array(target.reshape(shape).astype(values.dtype), item.name))
        changed += 1

    for node in model.graph.node:
        if node.op_type != "Constant" or len(node.attribute) == 0:
            continue
        attribute = node.attribute[0]
        if attribute.name != "value":
            continue
        values = numpy_helper.to_array(attribute.t)
        if values.dtype.kind not in "iu" or values.size != BASE_TOKENS:
            continue
        if values.flatten().tolist() != expected:
            continue
        shape = (1, tokens) if values.ndim > 1 else (tokens,)
        attribute.t.CopyFrom(numpy_helper.from_array(target.reshape(shape).astype(values.dtype)))
        changed += 1

    return changed


def rewrite_to_tokens(model: "onnx.ModelProto", tokens: int) -> dict:
    """把图从「写死 197」改写成「写死 tokens」：位置编码插值 + 形状常量 + 位置 id 改写。"""
    grid_from = int(round((BASE_TOKENS - 1) ** 0.5))
    grid_to = int(round((tokens - 1) ** 0.5))
    assert grid_to * grid_to + 1 == tokens, f"{tokens} 不是 (n²+1) 形式"

    position = None
    for item in model.graph.initializer:
        if list(item.dims) in ([BASE_TOKENS, 768], [1, BASE_TOKENS, 768]):
            position = item
            break
    if position is None:
        raise SystemExit(f"没找到含 {BASE_TOKENS} 维的位置编码初始化器，图结构与预期不符")
    leading = list(position.dims)[:-2]  # 保留前导维（通常是 batch=1）
    weights = numpy_helper.to_array(position).reshape(BASE_TOKENS, list(position.dims)[-1])
    resized = interpolate_positions(weights, grid_from, grid_to)
    position.CopyFrom(numpy_helper.from_array(resized.reshape(*leading, tokens, -1), position.name))

    rewritten = 0
    for item in model.graph.initializer:
        values = numpy_helper.to_array(item)
        # 只改「形状常量」：元素很少、且值里出现 197。位置编码本身是大张量，已单独处理
        if values.size <= 8 and BASE_TOKENS in [abs(int(value)) for value in values.flatten()]:
            patched = np.where(values == BASE_TOKENS, tokens, values).astype(values.dtype)
            item.CopyFrom(numpy_helper.from_array(patched, item.name))
            rewritten += 1
    return {
        "positionEmbedding": position.name,
        "shapeConstantsRewritten": rewritten,
        "positionIdsRewritten": rewrite_position_ids(model, tokens),
    }


def sanitize(model: "onnx.ModelProto", label: str) -> dict:
    """清掉 `extract_model` 带出来的陈旧形状注解，再重新推导一遍。

    这一步不是洁癖：`extract_model` 会把**源图**的 `value_info`（实测 667 条）一起复制出来，
    而那批注解里写死的 token 数是 197。ONNX/ORT 的形状推导会把它们当真，
    于是在改过常量的图上直接报 `Add: [ShapeInferenceError] Incompatible dimensions`
    ——实测就是在这一步卡住，跟位置编码/Reshape 常量都无关（见实测记录 §9.6）。
    """
    before = len(model.graph.value_info)
    del model.graph.value_info[:]
    try:
        onnx.shape_inference.infer_shapes(model, strict_mode=True, data_prop=True, check_type=True)
        status = "ok"
    except Exception as error:  # noqa: BLE001 —— spike 工具：推不出形状也要落盘，ORT 会自己再推一次
        status = f"failed: {str(error)[:120]}"
    print(f"  · {label}: 清掉 {before} 条陈旧注解，重新推导 shape inference → {status}")
    return {"staleValueInfoCleared": before, "shapeInference": status}


# ── 部署到 app 能发现的位置（public/models/derived/，gitignore）────────────────────
#
# 「派生产物只走本地生成」这条纪律的落地点：生成脚本把选定档位拷到 dev server 会服务的
# 目录，app 探测 `manifest.json` 决定走派生单塔还是回落原生双塔。仓库里永远没有权重
# （目录 gitignore，NOTICE §1）。

def deploy(
    source: pathlib.Path,
    suffix: str,
    resolution: int,
    tokens: int,
    text: pathlib.Path,
    deploy_dir: pathlib.Path,
) -> None:
    import shutil

    vision = OUT_DIR / f"vision{resolution}_{suffix}.onnx"
    if not vision.exists() or not text.exists():
        raise SystemExit(f"缺少产物：{vision} / {text}，先不带 --deploy 跑一次导出")

    deploy_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(vision, deploy_dir / vision.name)
    shutil.copy2(text, deploy_dir / text.name)
    manifest = {
        "model": "Xenova/chinese-clip-vit-base-patch16",
        "dtype": suffix,
        "note": "本地生成的派生产物（gitignore，不入库）；由 bench/export-towers.py --deploy 生成",
        "source": {"file": str(source.relative_to(ROOT)), "sha256": sha256(source)},
        "vision": {
            "file": vision.name,
            "resolution": resolution,
            "tokens": tokens,
            "bytes": (deploy_dir / vision.name).stat().st_size,
            "sha256": sha256(deploy_dir / vision.name),
        },
        "text": {
            "file": text.name,
            "bytes": (deploy_dir / text.name).stat().st_size,
            "sha256": sha256(deploy_dir / text.name),
        },
    }
    (deploy_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    )
    print(f"\n部署 → {deploy_dir}")
    print(f"  视觉塔 {manifest['vision']['file']}  {manifest['vision']['bytes'] / 1024 / 1024:.1f} MB")
    print(f"  文本塔 {manifest['text']['file']}  {manifest['text']['bytes'] / 1024 / 1024:.1f} MB")
    print(f"  清单 {deploy_dir / 'manifest.json'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect", action="store_true", help="只打印图结构，不写文件")
    parser.add_argument(
        "--dtype",
        default="q4f16",
        help="源权重档位（决定读 .cache/models/<repo>/<dtype>/model_<dtype>.onnx 与产物后缀）",
    )
    parser.add_argument(
        "--sizes",
        type=int,
        nargs="+",
        default=[224, 160, 112, 64],
        help="视觉塔分辨率档（16 的倍数；token = (size/16)²+1）",
    )
    parser.add_argument(
        "--deploy",
        type=int,
        metavar="SIZE",
        help="导出后把该档位的视觉塔 + 文本塔部署到 public/models/derived/（app 探测它决定走派生单塔）",
    )
    args = parser.parse_args()

    source = MODEL_DIR / args.dtype / f"model_{args.dtype}.onnx"
    suffix = args.dtype
    if not source.exists():
        raise SystemExit(
            f"缺少源权重：{source}\n先跑 `NODE_USE_ENV_PROXY=1 node scripts/fetch-models.mjs --dtype {args.dtype}`"
        )

    model = onnx.load(str(source))
    describe(model)
    if args.inspect:
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []

    def record(path: pathlib.Path, note: str, extra=None) -> None:
        size = path.stat().st_size
        entry = {"file": path.name, "bytes": size, "sha256": sha256(path), "note": note}
        if extra is not None:
            entry.update(extra)
        manifest.append(entry)
        print(f"  ✓ {path.name:<26} {size / 1024 / 1024:8.1f} MB  {note}")

    for resolution in args.sizes:
        tokens = (resolution // PATCH) ** 2 + 1
        target = OUT_DIR / f"vision{resolution}_{suffix}.onnx"
        onnx.utils.extract_model(str(source), str(target), [VISION_IN], [VISION_OUT])
        surgical = onnx.load(str(target))
        # 224² 是源图的原始分辨率：常量无需改写（改写也是恒等操作），省一次读改写
        report = (
            {"positionEmbedding": "unchanged", "shapeConstantsRewritten": 0}
            if tokens == BASE_TOKENS
            else rewrite_to_tokens(surgical, tokens)
        )
        report.update(sanitize(surgical, f"vision{resolution}"))
        onnx.checker.check_model(surgical)
        onnx.save(surgical, str(target))
        record(
            target,
            f"视觉塔 {resolution}² / {tokens} token",
            {"resolution": resolution, "tokens": tokens, **report},
        )

    text = OUT_DIR / f"text_{suffix}.onnx"
    onnx.utils.extract_model(str(source), str(text), TEXT_IN, [TEXT_OUT])
    surgical = onnx.load(str(text))
    sanitize(surgical, "text")
    onnx.checker.check_model(surgical)
    onnx.save(surgical, str(text))
    record(text, "文本塔整塔")

    manifest_path = OUT_DIR / ("manifest.json" if suffix == "q4f16" else f"manifest_{suffix}.json")
    # 与既有清单**合并**（按文件名去重）而不是覆盖：分次导出不同分辨率时，
    # 先前那批产物的 sha256 必须留着（同 fetch-models 的教训）
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"derived": []}
    fresh = {entry["file"] for entry in manifest}
    derived = [
        *(entry for entry in previous.get("derived", []) if entry.get("file") not in fresh),
        *manifest,
    ]
    derived.sort(key=lambda entry: entry["file"])
    manifest_path.write_text(
        json.dumps(
            {
                "source": str(source.relative_to(ROOT)),
                "source_sha256": sha256(source),
                "source_bytes": source.stat().st_size,
                "derived": derived,
                "note": "派生产物，不入库；由 bench/export-towers.py 生成（分次导出会合并，不覆盖）",
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    print(f"\n清单 → {manifest_path}")

    if args.deploy is not None:
        if args.deploy not in args.sizes:
            raise SystemExit(f"--deploy {args.deploy} 不在本次导出的 --sizes {args.sizes} 里")
        tokens = (args.deploy // 16) ** 2 + 1
        deploy(source, suffix, args.deploy, tokens, text, DERIVED_DIR)


if __name__ == "__main__":
    sys.exit(main())
