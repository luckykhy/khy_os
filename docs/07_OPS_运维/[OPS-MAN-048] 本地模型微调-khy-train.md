<!-- 文档分类: OPS-MAN-048 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-048] 本地模型微调-khy-train.md -->
# 本地模型微调（`khy train`）

> `khy train` 把你和 KHY 的交互记录整理成训练集，用 **LoRA / PEFT** 在**本地**对开源基座做轻量微调——全程生成并运行 Python 脚本，模型与数据都留在本机。本文讲清全部子命令、取值范围与前置条件，并**如实标注半实现部分**。
>
> 实现：`services/backend/src/services/modelTrainingService.js`，dispatch 在 `router.js:2371`。

---

## 一、它是什么 / 不是什么

- **是**：本地轻量微调流水线——收集交互记录 → 导出数据集 → LoRA 微调 → 导出 GGUF/safetensors → 可选上传 Git 仓库。
- **不是**：云端训练平台。`train cloud` 当前是**占位**（见 §六诚实边界）。

前置（缺失会直接抛错）：

- **Python 3.10+** 与 **PyTorch**（`trainLocal` 检测不到即报错并提示安装）。
- 导出 **GGUF** 需要 `llama-cpp-python`。
- 上传到 HuggingFace 需环境变量 `HF_TOKEN`。
- 设备/算力是否够用，先跑 [`khy compute`](（见 OPS-MAN-049）) 体检（CUDA / MPS / CPU 自动判定）。

> **数据门槛**：至少 **10 条**交互记录才能训练，建议 **50+** 才有意义。

---

## 二、入口与全部子命令

| 命令 | 作用 |
| --- | --- |
| `khy train status` | 查看训练环境、记录数、已注册模型 |
| `khy train data` | 查看 / 整理已收集的交互记录 |
| `khy train start [选项]` | 启动一次本地 LoRA 微调 |
| `khy train list` | 列出已训练 / 已注册模型 |
| `khy train export [选项]` | 把模型导出为 GGUF / safetensors |
| `khy train export-data [--format …]` | 导出训练数据集（不训练） |
| `khy train upload [选项]` | 上传模型到 Git 仓库（GitHub/Gitee） |

**`start` 选项**：

| 选项 | 取值 | 默认 |
| --- | --- | --- |
| `--base <model>` | `qwen-1.5b` `qwen-3b` `qwen-7b` `llama-3b` `llama-8b` `deepseek-1.5b` `deepseek-7b` `mistral-7b` | qwen-1.5b 档 |
| `--preset <p>` | `quick` / `standard` / `thorough` | `standard` |

**`export` 选项**：`--format gguf`（默认，配 `--quant q4_k_m`）/ `--format safetensors`。
**`export-data` 选项**：`--format alpaca|sharegpt|openai`。
**`upload` 选项**：`--platform github|gitee` `--repo <owner/name>`。

---

## 三、典型用法（可直接照抄）

```bash
# 0) 先体检算力（决定用 cuda / mps / cpu、是否 fp16）
khy compute

# 1) 看看攒了多少交互记录（要 ≥10 条）
khy train status
khy train data

# 2) 标准档微调 Qwen-3B
khy train start --base qwen-3b --preset standard

# 3) 导出成 GGUF（llama.cpp / Ollama 可直接加载），q4_k_m 量化
khy train export --format gguf --quant q4_k_m

# 4) 仅导出数据集（喂别的训练框架）
khy train export-data --format openai

# 5) 上传到自己的 GitHub 仓库
khy train upload --platform github --repo your-name/my-khy-lora
```

---

## 四、存储与环境变量

训练根目录 `TRAINING_DIR` 取值优先级：`$KHY_TRAINING_DIR` → `<dataHome>/training` → `~/.khyquant/training`。其下：

- `datasets/` —— 导出的训练集
- `models/` —— 微调产物
- `interaction_records.jsonl` —— 收集的交互记录（训练数据来源）
- `model_registry.json` —— 已训练模型注册表

| 环境变量 | 作用 |
| --- | --- |
| `KHY_TRAINING_DIR` | 覆盖训练根目录 |
| `HF_TOKEN` | 上传 HuggingFace 用的令牌 |

---

## 五、诚实边界（半实现 / 桩，务必知悉）

- **`khy train cloud` = 占位**：返回一个**假的 job id**，**没有**真实云端训练端点（`modelTrainingService.js:633`）。当前请只用本地 `start`。
- **`khy train distill`（router 分支）= 仅信息提示**：router 层只打印说明，**不真正调用**已实现的 `distill()`（`router.js:2486-2497`）。蒸馏能力在服务层存在但 CLI 这条路未接通。
- **`--password` 形同虚设**：export/upload 的密码校验 `verifyExportPassword` **恒返回 true**（`modelTrainingService.js:709`），不提供任何真实加密保护，别依赖它。
- 本地训练需要真实算力与依赖，缺 PyTorch/llama-cpp-python 会直接失败——这是**真实前置**，不是桩。

---

## 六、相关文档

- [OPS-MAN-049] 算力与加速器自检（`khy compute`）—— 训练前的设备体检。
- [OPS-MAN-050] 成长档案迁移（`khy growth`）—— 交互/成长数据的另一条迁移线。
