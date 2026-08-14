<!-- 文档分类: OPS-MAN-049 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-049] 算力与加速器自检-khy-compute.md -->
# 算力与加速器自检（`khy compute`）

> `khy compute` 是一条**只读体检命令**——一眼看清这台机器能不能跑本地训练/推理：CPU、内存、Python、PyTorch、以及 CUDA / MPS / `nvidia-smi` 加速器情况。**没有子命令、没有 flag**，跑一次看结果即可。
>
> 实现：`modelTrainingService.getComputeStatus()`，dispatch 在 `router.js:2348`。

---

## 一、它是什么

`khy train`（本地微调）在开训前需要知道「这台机器用什么设备、要不要开 fp16」。`khy compute` 就是把这套判定逻辑单独暴露出来，让你**先体检再训练**：

- 探测 **CPU 核数 / 内存**；
- 探测 **Python** 是否可用及版本；
- 探测 **PyTorch** 是否安装；
- 探测加速器：**CUDA**（NVIDIA，配合 `nvidia-smi`）/ **MPS**（Apple Silicon）/ 否则回落 **CPU**；
- 据此给出建议设备（cuda/mps/cpu）与是否启用 fp16。

---

## 二、用法（就这一条）

```bash
khy compute
```

输出会列出各项检测结果。把它当作 `khy train` 的**前置体检**：

```bash
khy compute                       # 1) 先看设备
khy train start --base qwen-3b    # 2) 设备 OK 再开训
```

---

## 三、读懂结果

| 检测项 | 含义 / 你该做什么 |
| --- | --- |
| Python 不可用 | 装 Python 3.10+，否则 `khy train` 无法运行 |
| PyTorch 未安装 | `pip install torch`（按你的 CUDA 版本选 wheel） |
| CUDA 可用 | 有 NVIDIA GPU，可大幅加速、通常开 fp16 |
| MPS 可用 | Apple Silicon（M 系列），可用 GPU 加速 |
| 仅 CPU | 仍可训练但很慢，建议用最小基座（如 qwen-1.5b）+ `quick` 档 |

---

## 四、相关文档

- [OPS-MAN-048] 本地模型微调（`khy train`）—— 体检通过后在这里开训。
