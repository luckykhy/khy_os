# [IMPL-RPT-030] Agnes 四模型一键置备：对话 + 文生图 + 图改图 + 视频

> 实现报告 · 遵循 [MGMT-STD-001] 文档铁律 · 对应设计归 `docs/03_DESIGN_设计/`，本目录索引见 `00_INDEX_实现-分类索引.md`

- **日期**：2026-06-20
- **范围**：Agnes AI（Sapiens）四个模型全部接入 Khy-OS，一把 Key 同时开通三大子系统。
- **状态**：定稿（40 测试绿，未提交）

## 一、背景与目标

Agnes AI 免费开放四个模型，但它们的能力分属 Khy-OS 中**三个互不相同的子系统**，绝不能用同一条路径接入：

| 模型 | 能力 | 子系统（env 命名空间） | 是否走网关代理 |
| --- | --- | --- | --- |
| `agnes-2.0-flash` | 对话 / 代码 / Agent 工具调用 | 对话 provider 池（`customProviderRegistrar`） | 是 |
| `agnes-image-2.1-flash` | 文生图 | `imageGenService`（`KHY_IMAGE_GEN_AGNES_*`） | 否 |
| `agnes-image-2.0-flash` | 图改图 / 多图合成 | 同上（编辑模型） | 否 |
| `agnes-video-v2.0` | 文生视频 / 图生视频 / 多图 / 关键帧 | `videoGenService`（`KHY_VIDEO_GEN_AGNES_*`） | 否 |

**关键约束**：网关代理只转发 chat/messages/responses/models，**不转发**图像与视频的异步 REST 接口。因此图像/视频模型**绝不能**进入对话预设的 `PROXY_MODEL_ROUTE_MAP`，只能经各自 service 的 env 接线。

## 二、实现内容

### 2.1 图像子系统（新增 agnes 后端）

`services/backend/src/services/imageGenService.js`：
- 新增 `agnes` 后端：`_generateAgnes()` 文生图用 `agnes-image-2.1-flash`，传入 `images` 时切换 `agnes-image-2.0-flash`（图改图）。
- **Agnes 特有兼容**：`response_format` 与 img2img 的 `image[]` 必须放进 `extra_body`，置于顶层会返回 HTTP 400。默认写 `extra_body`，逃生开关 `KHY_IMAGE_GEN_AGNES_REQUEST_STYLE=top_level` 可翻转。
- 后端优先级：`openai > agnes > domestic > sd_webui`，全部 env 驱动可覆盖。
- 新增工具 `services/backend/src/tools/imageEdit.js`（`image_edit`，别名 `img2img`/`图改图`/`图生图`/`换背景`/`局部编辑`/`多图合成`）：本地文件经 `_toImageRef()` 编码为 data URI（MIME 按扩展名，上限 12 MiB，写入路径封禁 `validateNoPathTraversal`）。

### 2.2 视频子系统（全新异步服务）

`services/backend/src/services/videoGenService.js`（Khy-OS 首个视频能力）：
- 异步任务模型：`POST {base}/v1/videos` → 轮询 `GET {base}/agnesapi?video_id=...&model_name=...`（兼容 `KHY_VIDEO_GEN_AGNES_POLL_STYLE=task_id` 的 legacy `/v1/videos/{task_id}`）→ 完成 URL 在 `remixed_from_video_id`。
- `validateFrameParams()`：`num_frames ≤ 441` 且满足 `8n+1`，`frame_rate ∈ [1,60]`，违反抛 `BAD_PARAM`。
- `_buildAgnesBody()`：单图走顶层 `image`；多图/关键帧走 `extra_body.image[]`（+ `extra_body.mode='keyframes'`）。
- 轮询节奏与超时 env 可调：`KHY_VIDEO_GEN_POLL_INTERVAL_MS`（默认 5s）/ `_MAX_WAIT_MS`（默认 10min），`_sleep` 用 unref 定时器。
- 新增工具 `services/backend/src/tools/videoGenerate.js`（`video_generate`，别名 `文生视频`/`图生视频`/`关键帧动画`/`text_to_video`/`image_to_video`）：提交→轮询→下载 MP4，下载失败时回退暴露 `videoUrl`。
- `capabilityRegistry.js` 新增 `video_gen` 能力维度 + 任务需求 + 中英文意图关键词。

### 2.3 一键置备（agnesProvisioner）

`services/backend/src/services/agnesProvisioner.js`：一把 Key → 三子系统。
- `provisionAgnes({ apiKey, chat, image, video, forceImageBackend, tier })`：
  - chat：复用 `customProviderRegistrar.registerCustomProvider()`（端点/模型取自共享预设，零硬编码）。
  - image：仅写 `KHY_IMAGE_GEN_AGNES_API_KEY`，base URL/模型用 service 既有默认；`forceImageBackend` 才写 `KHY_IMAGE_GEN_BACKEND=agnes`（默认不强占已有 openai 后端）。
  - video：仅写 `KHY_VIDEO_GEN_AGNES_API_KEY`。
- **状态透明**：返回值逐项报告哪些能力接通、写了哪些 env key、图像当前激活后端；Key 一律脱敏（`sk-x…xxxx`）。
- CLI 打通：`khy gateway add` 选 Agnes 预设后，交互式追问「是否一并接通图像/视频」；非交互式默认随同接通（`--media false` 关闭，非 Agnes 端点自动忽略）。

## 三、零硬编码与状态透明

- 无任何 Key/URL/模型写死：Key 由调用方传入，端点取自共享预设，模型走 service env 默认且全部可被 `KHY_*_AGNES_*` 覆盖。
- 三处写入 sink（图像保存、视频下载、本地图编码）均经路径封禁，限定项目树/用户目录。

## 四、测试

`node ~/Khy-OS/node_modules/jest/bin/jest.js`（从 `services/backend` 运行）：

| 测试文件 | 用例 | 结果 |
| --- | --- | --- |
| tests/agnesImage.test.js | 13 | 绿 |
| tests/agnesVideo.test.js | 12 | 绿 |
| tests/agnesProvisioner.test.js | 8 | 绿 |
| tests/customProviderRegistrar.test.js（回归） | 7 | 绿 |

合计 40 绿。其中 provisioner 测试断言图像/视频模型**绝不**进入 `PROXY_MODEL_ROUTE_MAP`，守住第一节的关键约束。

## 五、跨分类关联

- 共享注册器：`services/backend/src/services/customProviderRegistrar.js`（chat-only 预设）。
- 环境持久化：`services/backend/src/services/gatewayEnvFile.js`。
- 文档总入口：`docs/00_INDEX_文档索引.md`；本目录索引：`00_INDEX_实现-分类索引.md`。
