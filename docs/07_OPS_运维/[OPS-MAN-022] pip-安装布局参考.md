<!-- 文档分类: OPS-MAN-022 | 阶段: 运维 | 原路径: docs/指南/pip-安装布局参考.md -->
# pip 安装目录结构与源码映射参考

本文件用于说明：`pip install khy-os`（或 `khy-quant`）后，安装目录里每一块内容来自源码仓库的哪里。

> 若你使用 npm 安装，同样可用本项目的 `origin-code` / `npm-dir-bundle` 导出结构，见下文第 7 节。

## 1. 快速定位 pip 安装根目录

```bash
python -c "import pathlib, khy_platform; p=pathlib.Path(khy_platform.__file__).resolve(); print(p.parent.parent)"
```

输出一般是某个 `site-packages` 路径，例如：

`/path/to/python/lib/python3.x/site-packages`

## 2. 安装后核心目录（逻辑结构）

```text
site-packages/
|-- khy_platform/
|   |-- cli.py
|   \-- ...
|-- khy_os/
|   \-- bundled/
|       |-- services/backend/          (Node 后端：业务主体)
|       |-- apps/ai-frontend/          (AI 管理前端)
|       |-- software/khyquant/         (量化应用，含其 frontend)
|       |-- kernel/                    (自研 C 内核源码，无预编译 ISO)
|       |-- docs/
|       |-- alpine/
|       |-- scripts/
|       |-- extensions/
|       \-- platform/
\-- khy_os-<version>.dist-info/   (或 khy_platform-<version>.dist-info)
```

## 3. 源码 -> pip 安装目录映射

- `khy_platform/` -> `site-packages/khy_platform/`
- `services/backend/` -> `site-packages/khy_os/bundled/services/backend/`
- `apps/ai-frontend/` -> `site-packages/khy_os/bundled/apps/ai-frontend/`
- `software/khyquant/` -> `site-packages/khy_os/bundled/software/khyquant/`
- `kernel/`（源码，无预编译 ISO）-> `site-packages/khy_os/bundled/kernel/`
- `docs/` -> `site-packages/khy_os/bundled/docs/`
- `alpine/` -> `site-packages/khy_os/bundled/alpine/`
- `scripts/` -> `site-packages/khy_os/bundled/scripts/`
- `packages/shared/` -> `site-packages/khy_os/bundled/services/backend/vendor/shared/`（额外复制，确保 `@khy/shared` 可解析）

## 4. 运行时 backend 定位顺序

`khy_platform/cli.py` 会按以下顺序定位 backend：

1. 独立后端包（`khy-quant-backend`）
2. 源码开发模式：仓库内 `services/backend`（当 `.git` 存在时优先，避免与 bundled 漂移）
3. pip 模式：`khy_os/bundled/services/backend`
4. 兜底：源码 `services/backend`

这保证了：

- 本地开发优先用源码目录
- pip 安装时优先用 wheel 内 bundled backend

## 5. 一致性自检建议

### 5.1 校验关键目录存在

```bash
python - <<'PY'
import pathlib, khy_platform
site = pathlib.Path(khy_platform.__file__).resolve().parent.parent
checks = [
    site / "khy_platform" / "cli.py",
    site / "khy_os" / "bundled" / "services" / "backend" / "package.json",
    site / "khy_os" / "bundled" / "services" / "backend" / "server.js",
    site / "khy_os" / "bundled" / "apps" / "ai-frontend" / "package.json",
]
for p in checks:
    print(("OK   " if p.exists() else "MISS "), p)
PY
```

### 5.2 校验 `@khy/shared` 依赖已本地化

```bash
python - <<'PY'
import json, pathlib, khy_platform
site = pathlib.Path(khy_platform.__file__).resolve().parent.parent
pkg = site / "khy_os" / "bundled" / "services" / "backend" / "package.json"
dep = json.loads(pkg.read_text(encoding="utf-8")).get("dependencies", {}).get("@khy/shared")
print(dep)
PY
```

期望输出：`file:./vendor/shared`

## 6. 导出包内结构说明文件

通过以下命令导出的包会自动携带结构说明：

- `khy publish docker-bundle`
- `khy publish pip-dir-bundle`
- `khy publish npm-dir-bundle`
- `khy publish origin-code`

压缩包根目录会包含：

- `INSTALL_LAYOUT.md`（可读）
- `INSTALL_LAYOUT.json`（可解析）

## 7. npm 安装场景说明

当在 npm 安装场景下导出时（自动探测或 `--install npm`）：

- `khy publish npm-dir-bundle` 会导出 `npm-install/backend` 为 Docker 部署入口。
- `khy publish origin-code --install npm` 会尽可能从 npm 安装目录还原：
  - `backend/`（必有）
  - `frontend/`, `docs/`, `alpine/`, `scripts/alpine/`, `packages/shared/`（若安装目录中存在）

常用命令：

```bash
khy publish npm-dir-bundle --npm-root /path/to/npm-install-root
khy publish origin-code --install npm --npm-root /path/to/npm-install-root
```

## 8. 源码发布密钥与扰乱模式

`origin-code` 与 `git-push` 属于源码能力，支持密钥门禁：

- 完整模式：提供密钥后执行完整源码还原/推送。密钥来源（任一即可）：
  - 环境变量 `KHY_SOURCE_PUBLISH_SECRET`（或 `KHY_OWNER_SECRET`）；
  - 命令行 `--secret <你的密钥>`。
  - 说明：`khy2026` 是代码内置的**默认学习口令**（`DEFAULT_SOURCE_SECRET`），用它加密的学习快照可零额外步骤还原——它按设计是公开默认值，**不是**需要保密的凭据。生产/自有快照请用上面的环境变量设你自己的密钥覆盖它。
- 扰乱模式：未提供密钥或密钥错误时自动降级

扰乱模式行为：

- `origin-code`：保留目录骨架，但会移除/改写核心技术实现文件
- `git-push`：自动转为 `dry-run`，仅输出推送计划，不执行真实源码推送

## 9. pip / npm 冲突仲裁（auto 模式）

当 `--install auto` 且本机同时检测到 pip 与 npm 安装布局时，发布器会自动仲裁：

1. 先比较 backend 版本号，优先更高版本
2. 版本相同则比较 `package.json` 最近修改时间，优先更新更晚的一侧
3. 若仍相同，默认回退到 pip

这样可以让 pip 与 npm 安装互相更新时，以“最新有效安装”为准，避免固定优先级造成冲突。

## 10. 为什么 pip 装完后不能直接 `khy` 就跑起来（启动故障排查）

`pip install` 只完成了**「Python 启动器」**这一层。`khy`（首启入口）真正跑起来，是 Python
启动器再去拉起 Node.js 后端，因此在 Windows 上还需另外几层依赖，缺一不可：

| 层 | 检查项 | 缺失时的现象 |
|----|--------|--------------|
| 1 | `khy` 可执行文件在 PATH 上 | `'khy' 不是内部或外部命令` |
| 2 | Node.js >= 20 | 提示 “Node.js not found / >= 20 required” |
| 3 | `services/backend/node_modules` 已安装 | 首启卡在 `npm install` 或 `Cannot find module` |
| 4 | 全局 `claude` CLI（**仅** `khy claude` 需要，普通对话不需要） | `错误: 未找到 claude 命令` |

### 10.1 一键体检：`khy preflight`

```bash
khy preflight        # 别名：khy precheck
```

该命令在启动早期对上述四层集中体检，**不触发 Node 后端**，逐项输出
`[ OK ] / [WARN] / [FAIL]` 并给出 Windows 专属、可直接粘贴执行的修复指引。
退出码：存在阻塞项=1，仅警告或全部通过=0。

> 若 `khy` 还没进 PATH（第 1 层就失败），用兜底方式调用：
> `python -m khy_platform preflight`

### 10.2 各层典型修复

- **第 1 层（PATH）**：pip 把 `khy.exe` 放在 Scripts 目录（全局
  `<Python>\Scripts\`，或 `pip install --user` 的
  `%APPDATA%\Python\Python3X\Scripts\`），该目录默认不在 PATH。
  `khy preflight` 会打印实际目录与可粘贴的 PowerShell 加 PATH 命令；
  或始终可用 `python -m khy_platform <子命令>` 兜底（等价于 `khy <子命令>`，如
  `python -m khy_platform preflight`）。
- **第 2 层（Node）**：`winget install OpenJS.NodeJS.LTS`（国内可用
  npmmirror 镜像）。
- **第 3 层（依赖）**：跑一次正常启动会自动 `npm install`；手动修复
  `cd <bundled/services/backend> && npm install`。Windows 上若因长路径失败，启用
  Win32 长路径或 `git config --system core.longpaths true`；若 site-packages
  只读，改用 `pip install --user khy-os`。
- **第 4 层（claude）**：`npm install -g @anthropic-ai/claude-code`。

实现见 `platform/khy_platform/cli.py` 的 `_run_preflight_cli` 及 `_pf_check_*` 系列函数。

## 11. pip 打包规则维护约定

这一节是维护者的操作准则，目标是防止打包时漏文件、重复打文件，或者出现
“sdist 和 wheel 各自一套规则”的漂移问题。

### 11.1 单一真源

- 规则真源只有一份：`scripts/release/pip_packaging_rules.py`
- `MANIFEST.in` 是生成文件，禁止手工编辑
- `setup.py`、`MANIFEST.in`、打包审计脚本都必须从同一份规则读取

### 11.2 sdist 和 wheel 的职责

- sdist 负责保留“可重建 wheel 的源码和构建输入”
- wheel 负责保留“运行时真正需要的 bundled 载荷”
- 任何 `node_modules`、编译产物、模型权重、缓存、临时目录，都不应该进入 pip 产物
- 任何重建 wheel 需要的文件，都必须显式进入 sdist

### 11.3 修改流程

新增、删除或移动 pip 打包文件时，按这个顺序操作：

1. 先改 `scripts/release/pip_packaging_rules.py`
2. 再运行 `python3 scripts/release/render_manifest.py`
3. 再运行 `python3 scripts/release/check_manifest_sync.py`
4. 再运行 `bash scripts/release/build-and-audit-pip-purity.sh`

如果本地环境无法联网，但已经装好了 `build`、`setuptools`、`wheel`，可改用：

```bash
bash scripts/release/build-and-audit-pip-purity.sh --no-isolation
```

### 11.4 如何判断警告是不是问题

- `no previously-included ...` 一类警告，通常只是说明当前工作区里没有命中对应路径
- 只有以下情况才算真正的打包问题：
  - 该出现的源码没进 sdist 或 wheel
  - 不该出现的第三方依赖树、二进制、模型文件进了产物
  - `MANIFEST.in` 和规则真源不同步
