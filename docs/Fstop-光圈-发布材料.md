# Fstop · 发布材料（M3）

> 用途：发布时直接取用。**所有数字都能指向一条可复跑的实测**（`docs/Fstop-光圈-技术说明.md` §3/§4），
> 别改成更好看但不实的说法 —— 这个项目的卖点就是「可核对」，宣传口径破了功就没了。

## 一、仓库信息

- **GitHub topics**：`photo-search` `semantic-search` `clip` `local-first` `privacy` `webgpu`
  `onnxruntime` `browser` `opfs` `no-server` `offline` `typescript`
- **一句话简介（About）**：Local semantic photo search that runs in your browser tab — no server,
  no uploads, no install; your photos are never copied.
- **第一屏该出现的东西**（README 已就位）：是什么 → 与现有方案的区别表 → Try it（内置 39 张样例，
  点一下就能跑）→ Hard limits（0 字节拷贝 / 除模型 origin 外零外发 / 平台范围 / 核心可读）

## 二、Hacker News（Show HN）

标题候选（按可信度排序，不吹性能）：

    Show HN: Fstop – semantic photo search in a browser tab, photos never leave your disk
    Show HN: A photo search engine that runs entirely in your browser (no server, no uploads)

正文草稿：

    I wanted to search my own photo library with a sentence without installing anything or
    uploading anything, so I built the whole pipeline inside a browser tab: File System Access
    for handles (no copies), CLIP-family model on WebGPU, index in OPFS (a flat Float32 matrix
    plus SQLite).

    Numbers are measured, not extrapolated, on a 2020s Mac in stock Chrome:
    - 783 real CC0 photos indexed at 13.6 photos/s (10k extrapolates to 12.3 min); a re-exported
      192² single tower hits 18.56/s (9.0 min)
    - text query 28 ms + cosine over the matrix 7.3 ms (budget 300 ms)
    - Chinese queries R@1 46.2% on a 106-query set, which is statistically indistinguishable
      from the stock 224² dual tower (McNemar p = 0.774)

    The part I'd most like feedback on: "zero external requests except the model origin" is
    enforced three ways (static scan in CI, runtime assertion in the e2e, and an in-app panel that
    records the requests the browser actually made and names any offending host in red), and the
    photos stay where they are. Limitations are real and listed in the README: HEIC/RAW don't
    decode in Chromium, indexing stops when the tab closes, desktop Chromium only.

    Repo: <link> — click "try the bundled samples" and it indexes 39 bundled CC0 photos with no
    folder picker at all.

## 三、V2EX / 少数派（中文）

标题候选：

    我做了一个不搬照片、不上传的照片语义检索：选个文件夹，浏览器自己建索引
    把 CLIP 塞进浏览器标签页：照片不复制、不上传的本地语义检索

正文草稿（V2EX 版，短）：

    起因很土：我的照片散在几个盘里，想用一句话找「去年海边那张日落」，不想搬家、不想装东西、
    更不想传上去。

    做法是整条链路都在浏览器里跑：File System Access 拿文件句柄（不复制）、WebGPU 跑 CLIP 家族
    模型、索引写在浏览器自己的存储里（扁平 Float32 向量矩阵 + SQLite）。真实语料 783 张
    CC0 原图实测 13.6 张/秒（1 万张外推 12.3 分钟），重导出的 192² 单塔 18.56 张/秒；
    检索 28 ms + 矩阵余弦 7.3 ms（预算 300 ms）。

    「除模型 origin 外零外发」这句不是自述：CI 静态扫描、端到端运行时断言、应用内离线面板
    （记浏览器真发出的请求，出现外部 host 红着点名）三层互证。

    诚实的限制：Chromium 解不开 HEIC/RAW；标签页关了索引就停（浏览器路线的固有短板）；
    只有桌面 Chromium。

    仓库里带了 39 张 CC0 样例，打开点「先试用内置样例」就能跑通全链路，不用授权任何目录：
    <link>

少数派版本：把上面「起因」扩成一段场景叙事，加 2–3 张截图（索引进度 / 检索结果 / 离线能力面板），
并在结尾强调「离线能力面板」那一屏 —— 这是同类项目里少见、且用户能自己核对的承诺。

## 四、发布前的检查清单

- [ ] `pnpm verify` 全绿（单测 + lint + typecheck + 静态零外发）
- [ ] `pnpm build && node bench/e2e-samples.mjs` 全绿（构建产物可静态部署 + 内置样例可跑 + 零外发）
- [ ] 六条端到端全绿：app / wall / tabs / similar / faces / samples（`samples` 跑的是 `dist/` 构建产物）
- [ ] `NOTICE` 的模型许可段落与界面/README 口径一致（人脸识别模型是**非商用**）
- [ ] 动了 UI 就必须过**像素级**断言：`node bench/e2e-faces.mjs` 的 7 条画面断言（元素存在 / 尺寸符合算式 /
      可见窗口对准人脸中心 / 裁切区有内容 / 格子 ≥100px），只跑数据断言会出现「断言全绿、用户看到白图」
- [ ] `pnpm build && pnpm release:package` 打包发布物：**发布物里不许出现任何 `.onnx`**
      （`public/models/derived/` 是派生的中文 CLIP 权重，上游模型卡未授权再分发 —— 打包脚本发现权重会直接失败）
- [ ] 用**发布物本身**再跑一次端到端：`E2E_DIST=<发布物目录> node bench/e2e-samples.mjs`。
      剥离派生权重后应用会走原版双塔回退路径，这条路径也必须是绿的（那才是别人下载到的东西）
- [ ] README 的 Status 与实测记录一致（数字、里程碑状态）
- [ ] 部署后**自己**点一遍「先试用内置样例」：离线面板必须没有违规 host（页面自身 origin 不算外部）
- [ ] 截图三张：索引进度、检索结果、离线能力面板（含 host 账本）

## 五、本次发布（v0.3.0 · M1+M2+M3 全清）

给 GitHub Release / 变更说明直接取用：

    v0.3.0 — M1 / M2 / M3 全部收口

    功能
    - 在本机建索引的语义检索：句柄代替拷贝、WebGPU 跑 CLIP 家族模型、索引落在 OPFS
      （扁平 Float32 矩阵 + SQLite），照片不复制、不上传、不装任何东西
    - 相似/重复图分组（阈值聚类 + 全链约束）
    - 检索结果按时间/相似度重排（EXIF 优先，缺失时如实标「时间未知」）
    - 人脸聚类与人物命名（检测 → 对齐 → 识别 → 全链约束聚类；命名 / 合并 / 拆分）
    - 离线能力可视化面板：记浏览器真发出的请求，外部 host 红着点名
    - 发布形态：dist/ 纯静态站点 + 内置 39 张 CC0 样例（打开即可体验）

    实测（2020s Mac / 系统 Chrome / 可复跑，环境随数字一起引）
    - 真实语料 783 张 CC0：13.6 张/秒（1 万张外推 12.3 分钟）；重导出 192² 单塔 18.56 张/秒（9.0 分钟）
    - 检索：文本编码 28 ms + 矩阵余弦 7.3 ms（预算 300 ms）
    - 中文检索质量：192² 单塔 R@1 46.2% vs 224² 双塔 48.1%（McNemar p = 0.774，不可测差异）
    - 人脸：7 张标注肖像 → 7 张脸 → 恰好 2 组、零混合；同人余弦 0.506–0.995、异人 ≤0.031

    门禁
    - pnpm verify：216 单测 + lint + typecheck + 静态零外发断言
    - 六条端到端全绿（app / wall / tabs / similar / faces / samples）
    - 人脸面板 7 条**像素级**断言（含「可见窗口对准人脸中心 Δ=0.0」「格子 ≥100px」）

    发布物
    - fstop-0.3.0-dist（纯静态站点，约 37 MB / 51 个文件，内置 39 张 CC0 样例）
    - **不含模型权重**：运行时按需从模型 origin 取，浏览器缓存；派生权重只本地生成、不分发
    - 校验：产物目录内 SHA256SUMS；RELEASE.txt 记录了提交与门禁结果

    已知限制（都在 README / 技术说明里写清）
    - Chromium 解不开 HEIC/RAW；标签页关闭即停；只有桌面 Chromium（113+，需 WebGPU）
    - 人脸识别模型 antelopev2 是**非商用**条款，启用即约束整个项目
    - 人脸语料只有 7 张 2 人：能证明「不混人、同人成组」，给不出召回率

## 六、发布后要盯的

- 首次访问要下模型权重（默认档 ~47.5 MB）：把「首次慢、之后走浏览器缓存」写进第一屏，别让人以为卡住。
- 「第二个标签页只读」是设计而非故障：UI 已有说明文案，注意收反馈时别被当成 bug 修掉。
- 如果收到 HEIC/RAW 需求：这是**明确排除**项（Chromium 解不开），要走 libheif wasm 是新一轮决策，
  不要顺手答应。
