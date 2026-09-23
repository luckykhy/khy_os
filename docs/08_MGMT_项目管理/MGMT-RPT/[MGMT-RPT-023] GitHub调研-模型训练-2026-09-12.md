# GitHub 调研 — 模型训练板块（LoRA/蒸馏/导出）— 2026-09-12

> 每日板块轮转调研（索引 3/12）：khy-os 模型训练板块（`services/backend/src/services/modelTrainingService.js`、`trainingDataService.js`、`services/backend/scripts/uncensor_model.py`）对标 GitHub 开源 LLM 微调/蒸馏工具链，寻找可借鉴点。

## 调研对象

khy-os 模型训练板块现状：

| 组件 | 位置 | 机制 |
|---|---|---|
| 数据记录 | `modelTrainingService.js` §1 TrainingDataRecorder | 被动记录交互 → JSONL；水质量过滤 + 毒化/密钥模式隔离 |
| 本地训练 | `trainLocal` + `generateTrainScript` | 生成 Python 脚本（transformers + peft），spawn 子进程；预设 quick/standard/thorough |
| 蒸馏 | `distill` | AI gateway 生成教师回复 → 学生 LoRA 训练（离线文本级） |
| 导出 | `exportGGUF` / `exportSafetensors` / `registerWithOllama` / `uploadToGitRepo` | llama.cpp / HF 格式 + Ollama 注册 + Git LFS 私有仓 |
| 版本管理 | `getNextVersion` / `rollbackModel` / `setActiveModel` | `khy-<version>` 命名 + env 回滚 |
| 消融 | `abliterateModel` | 权重正交化去拒绝行为（uncensor_model.py） |

**短板（4 条）**：

1. **进度追踪粗**：靠 regex 抓 Python stdout 里的 `%` 数字（`generateTrainScript` 只在开头打印 "0%"、结尾打印 "100% complete"），中途无任何结构化的 loss/epoch/lr 信号，`onProgress` 回调实际只能等两个端点。
2. **训后无评测门**：训练完成即 `registerModel`，没有任何 val-loss / 探针评测 / 自动回滚判定——`rollbackModel` 存在但纯人工触发，且 `setActiveModel` 的「取最新」分支用字符串 `.sort()` 而非数值比较（khy-1.10 会排在 khy-1.9 之前）。
3. **配方可复现性差**：预设 quick/standard/thorough 是写死的 JS 常量，训练运行不记录超参快照（seed、git 状态、数据量、时间戳），出问题无法复现。
4. **数据整备弱**：只有水质量/毒化/密钥三道过滤器，没有去重（dedup）、train/val 切分、质量分桶（对比 distilabel 的 MinHash 去重 + DEITA 三维打分）。

## 对标项目

| 项目 | Star（2026-09-12） | 技术栈 | 相关度 | 链接 |
|---|---|---|---|---|
| LlamaFactory | ~74.7k | Python（PyTorch/transformers/PEFT，YAML 配方） | 高：单配置面统一 SFT/LoRA/DPO/eval | https://github.com/hiyouga/LlamaFactory |
| unsloth | ~76k | Python（HFTrainer 补丁 + 自定义 CUDA 内核） | 高：khy-os 已 spawn 其生态 | https://github.com/unslothai/unsloth |
| Axolotl | ~12.5k | Python（YAML 配方 + HFTrainer + click） | 高：训后 lm-eval 门 + 可插拔后端 | https://github.com/axolotl-ai-cloud/axolotl |
| distilabel | ~3.4k | Python（Ray/DataSlices DAG） | 中：蒸馏数据管线（去重/打分） | https://github.com/argilla-io/distilabel |
| Open WebUI | ~151.8k | FastAPI + Vue | 低：本地模型发现/切换 UI 模式 | https://github.com/open-webui/open-webui |

## 值得借鉴的点

### 1. JSON-lines 结构化训练日志（P0）

**对方怎么做**：LlamaFactory `src/llamafactory/train/callbacks.py` 的 `LogCallback.on_log` 把 `loss/eval_loss/lr/epoch/percentage/elapsed_time/remaining_time/throughput` 以 JSON 行追加写入 `trainer_log.jsonl`；unsloth `PipeCapture`（环形缓冲 + 就绪正则）提供 Windows 下稳定的子进程 stdout 捕获。

**khy-os 现状差在哪**：`generateTrainScript` 生成的 Python 脚本只打印 "0%"/"100%"，`trainLocal` 靠 `text.match(/(\d+)%/)` 抓进度——两个端点之间的 2-5 小时完全黑盒；CLI 的 `onProgress` 回调（`routerDispatchOps.js:905`）拿到的是截断的整块 stdout。

**改哪些文件**：`services/backend/src/services/modelTrainingService.js`（generateTrainScript + trainLocal）。

### 2. 训后评测门 + 自动回滚（P0）

**对方怎么做**：Axolotl `src/axolotl/integrations/lm_eval/args.py` 的 `lm_eval_post_train: bool = True` 开关，`cli.py` 的 `build_lm_eval_command` 把 `lm_eval --model hf --tasks ...` 串进配方，结果落 `lm_eval_results/` 时间戳目录；LlamaFactory `eval/evaluator.py`（MMLU/C-Eval 选择概率打分）。

**khy-os 现状差在哪**：训练成功 → 直接 `registerModel`，无论质量好坏；`rollbackModel` 是纯手动。应改为：训后跑轻量探针评测（自家数据 val 切分 perplexity + 少量固定探针），与基线（base model 或上一版本）比较，劣化超阈值自动回滚 active 版本并标记 registry。

**改哪些文件**：`modelTrainingService.js`（trainLocal 尾部 + 新增 evaluateModel/探针逻辑 + setActiveModel sort 修复）。

### 3. 配方可复现 YAML 快照（P0）

**对方怎么做**：LlamaFactory 全部超参走 YAML（`examples/`），`hparams/parser.py` 单一解析入口；Axolotl 把 DictDefault 配方整包落盘；两者都会把 seed、数据 hash、git commit 写进 run 目录。

**khy-os 现状差在哪**：`TRAINING_PRESETS` 是 JS 常量，`registerModel` 只存 `basedOn/method/datasetSize/trainedAt/path`——没有 epochs/lr/LoRA 参数快照、没有 dataset 指纹、没有 git hash。khy-1.0 出问题无法回答「当时到底用什么参数、什么数据训的」。

**改哪些文件**：`modelTrainingService.js`（registerModel 写入 `recipe.json` 快照 + trainLocal 组装快照）。

### 4. val-loss 门 + EarlyStopping（P1）

**对方怎么做**：Axolotl `evaluate.py` 对 train/eval 双数据集跑 `trainer.evaluate` 写 `eval_summary.csv`；HFTrainer 原生 `EarlyStoppingCallback`。

**khy-os 现状差在哪**：`generateTrainScript` 的 tokenize 函数里 `tokens["labels"] = tokens["input_ids"].copy()`——**pad token 也进了 labels**，loss 被 pad 稀释；且没有 train/val 切分。应：labels 中 pad 位置置 -100、`--split` 95/5、`EarlyStoppingCallback(patience=2)`。

**改哪些文件**：`modelTrainingService.js`（generateTrainScript）。

### 5. MinHash 去重 + 质量分桶（P1）

**对方怎么做**：distilabel `steps/filtering/minhash.py`（datasketch MinHashLSH 去重）+ `steps/deita.py`（diversity/quality/complexity 三维打分 + 聚类采样）。

**khy-os 现状差在哪**：数据侧只有长度/单一字符占比/毒化/密钥过滤，重复交互会进训练集稀释多样性；`exportDataset` 无 train/val 语义切分。可先做 64-gram 前缀去重 + 简单质量分（长度中位数 + 反馈评分），DEITA 打分留后续。

**改哪些文件**：`modelTrainingService.js`（exportDataset + 新增 dedup）。

### 6. 多教师投票/拒采样蒸馏（P2）

**对方怎么做**：distilabel `pipeline/routing_batch_function.py` 拒采样路由 + 多 LLM step 组合；unsloth `SyntheticDataKit` 题型配比批量合成。

**khy-os 现状差在哪**：`distill` 是单教师（aiGateway best-available）顺序生成、失败静默跳过、无题型配比。留作后续。

### 7. 模型发现/切换 UI（P2）

**对方怎么做**：Open WebUI `utils/models.py` `get_all_base_models` 聚合 Ollama + OpenAI 兼容端点。

**khy-os 现状差在哪**：`registerWithOllama` 注册后前端不自知。低优先。

## 落地建议（排序）

| # | 行动 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | Python 侧生成 JSON-lines 训练日志（loss/eval_loss/lr/epoch/percentage/elapsed/remaining），Node 侧逐行解析驱动 `onProgress` | P0 | 半天 |
| 2 | 训后评测门：train/val 95/5 切分 + val-perplexity 探针 + 劣化自动回滚；顺带修复 `setActiveModel` 字符串排序 bug | P0 | 半天 |
| 3 | 配方可复现：每次训练写 `recipe.json`（预设参数 + dataset 指纹 + git hash + seed + 时间戳）到模型目录 | P0 | 1 小时 |
| 4 | 修 labels pad 污染 + EarlyStopping + train/val 切分进 Python 脚本 | P1 | 半天 |
| 5 | exportDataset 加前缀去重 + 质量分桶 | P1 | 半天 |
| 6 | 多教师投票/拒采样蒸馏 | P2 | 数天 |

## 参考链接

- https://github.com/hiyouga/LlamaFactory — `src/llamafactory/train/callbacks.py`（LogCallback）、`eval/evaluator.py`
- https://github.com/unslothai/unsloth — `unsloth/dataprep/synthetic.py`（PipeCapture/SyntheticDataKit）
- https://github.com/axolotl-ai-cloud/axolotl — `integrations/lm_eval/args.py`（lm_eval_post_train）、`utils/trainer.py`、`evaluate.py`
- https://github.com/argilla-io/distilabel — `steps/filtering/minhash.py`、`steps/deita.py`
- https://github.com/open-webui/open-webui — `backend/open_webui/utils/models.py`

## 落地记录

### 已实现条目

**P0-1 JSON-lines 结构化训练日志（LlamaFactory LogCallback 模式）** — ✅ 已实现
- `buildTrainLogHelper()`：生成内联到 Python 脚本的 `khy-trainlog/v1` 辅助块（`_khy_log_event` 写 `$KHY_TRAIN_LOG`，含 `log_header/epoch_start/log_step/epoch_end/done` 五类事件）
- `parseTrainLogProgress(raw)`：Node 侧 JSON-lines 解析器，容忍尾部被截断的行，输出 `pct/epoch/step/loss/evalLoss/lr/elapsedSec/remainingSec`
- `trainLocal`：新增 2s 轮询 tail 读日志（`fs.openSync/readSync`，非阻塞 kill 语义——仅读文件，符合规则 3），`onProgress` 回调拿到 `step n/m · epoch x/y · loss=… · lr=…` 结构化进度；旧 regex % 逻辑保留为 fallback
- `generateTrainScript`：注入 `KhyTrainLogCallback`（Trainer callback，`on_log` 时发射 `log_step` 事件），`_khy_emit_header()` 在 `trainer.train()` 前发射，`_khy_done(trainer.state.global_step)` 在保存后发射

**P0-2 配方可复现 recipe.json 快照（LlamaFactory YAML / Axolotl DictDefault 模式）** — ✅ 已实现
- `buildRecipeSnapshot()`：捕获 `hyperparams（epochs/lr/batchSize/loraR/loraAlpha/seed/warmupRatio）` + `data（path/count/sha256 前 16 位指纹）` + `compute（platform/arch/cpus/totalRAM/cuda/mps/gpu）` + `environment（nodeVersion/python/torch/gitHash/gitDirty）`，schema 为 `khy-recipe/v1`
- `registerModel`：`metadata.recipe` 自动分离并调用 `writeRecipeSnapshot` 落盘到模型目录（`recipe.json`），不进入 registry JSON（避免重复）
- `readRecipeSnapshot(outputDir)`：回读快照
- `trainLocal` 成功路径：组装快照 → `registerModel` 携带 `recipe` → 写盘

**P0-3 训后评测门 + 自动回滚（Axolotl `lm_eval_post_train` 模式）** — ✅ 已实现
- `EVAL_PROBES`：4 条确定性探针（算术、量化术语、Python 代码、年化波动率），用 `expectContains` 判定，阈值默认 0.7
- `evaluateModel(modelDir, modelName, opts)`：对本地 Ollama（端点取自 `constants/serviceDefaults.js` 的 `OLLAMA_HOST`，不硬编码端口）跑探针；Ollama 不可达时 **fail-open** 返回 `{ skipped: true, reason }`，绝不因评测门失败导致训练失败
- `autoRollbackOnEvalFailure(failedModelName, evalResult)`：未通过时把 active 版本数值回滚到上一个 `khy-<version>`（修掉字符串排序 bug——khy-1.10 排在 khy-1.9 前），并把 `evalResult/evalStatus/rolledBackTo` 写进 registry
- `trainLocal` 新增 `skipEvalGate` / `autoRollback` / `evalPassThreshold` 三个选项，默认开评测门 + 开自动回滚
- `routerDispatchOps.js` `train start`：训练成功后打印评测门结果（通过/未通过/跳过 + 分数 + 配方路径）

**P1 顺带修（train/val 切分 + pad 修复 + EarlyStopping）** — ✅ 已实现（随 P0-1 的 `generateTrainScript` 注入）
- `tokenize`：`labels` 中 pad token 位置置 `-100`（此前 pad 也进 labels，loss 被稀释）
- `dataset.train_test_split(test_size=0.05, seed=42)`：≥20 条时切分，喂 `EarlyStoppingCallback(patience=2, metric="eval_loss")` 和 `load_best_model_at_end`

### 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `services/backend/src/services/modelTrainingService.js` | 改 | +`buildTrainLogHelper`/`parseTrainLogProgress`/`buildRecipeSnapshot`/`writeRecipeSnapshot`/`readRecipeSnapshot`/`EVAL_PROBES`/`evaluateModel`/`autoRollbackOnEvalFailure`；改 `trainLocal`/`generateTrainScript`/`registerModel`/`setActiveModel`/`getNextVersion`；+`crypto` import |
| `services/backend/src/cli/routerDispatchOps.js` | 改 | `train start` 成功路径打印评测门结果 + 配方路径 |
| `services/backend/src/services/__tests__/modelTrainingService.trainLog.test.js` | 新增 | 10 个 jest 用例覆盖日志解析、配方快照、评测门 fail-open、自动回滚 |

### 检查结果

- `node -e "require('./services/backend/src/services/modelTrainingService.js')"`：✅ 加载成功，38 个导出
- `node scripts/ci/check-agent-rules.js services/backend/src/services/modelTrainingService.js services/backend/src/cli/routerDispatchOps.js`：✅ 通过，无违规
- `npx jest src/services/__tests__/modelTrainingService.trainLog.test.js`：✅ 10/10 通过
- 生成的 LoRA / full 微调 Python 脚本各用 `python -c "import ast; ast.parse(...)"` 校验语法：✅ 均通过

### 未实现项（标「待人工决策」）

- **P1 MinHash 去重 + DEITA 质量分桶**：需引入 `datasketch` 依赖 + 数据整备管线重构，影响面大，建议单独立项
- **P2 多教师投票 / 拒采样蒸馏**：`distill` 目前是单教师顺序生成，改造需先定题型配比协议，建议先跑 1-2 轮评测门积累基线后再做
- **P2 模型发现 UI（Open WebUI 模式）**：`registerWithOllama` 注册后前端不自知，需前端配合，建议与前端团队对齐后做
