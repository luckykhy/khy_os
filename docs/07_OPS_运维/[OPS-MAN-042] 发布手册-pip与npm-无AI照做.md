# [OPS-MAN-042] 发布手册：pip 与 npm（无 AI 也能照做）

> 目的：把"发布一个新版本"变成**照抄命令**就能完成的机械流程，不依赖 AI、不依赖记忆。
> 适用：把 `khy-os` 发到 PyPI、把 `@khy-os/khy-os` 发到 npm。
> 单一真源脚本：`scripts/release/publish-dual.sh`（双渠道、审计门禁、可打 tag）。

---

## 0. 一句话结论

**正常情况下，你只需要跑一条命令：**

```bash
bash scripts/release/publish-dual.sh <新版本号> --tag --push -y
```

例：发 0.1.126 → `bash scripts/release/publish-dual.sh 0.1.126 --tag --push -y`

这条命令会：①把版本号同步进 4 个文件 → ②pip 干净构建+纯净度审计 → ③npm 组装+审计 → ④两边都审计通过后才上传（pip 走 twine，npm 走 npm publish）→ ⑤提交版本号改动 + 打 `v<版本>` 标签并推送远端。

如果只想发其中一个渠道，加 `--skip-npm`（只发 pip）或 `--skip-pip`（只发 npm）。

> 如果你不放心，**先加 `--dry-run` 彩排一遍**（构建+审计全跑，但不真正上传、不打 tag）。看到全绿再去掉 `--dry-run` 真发。

---

## 1. 一次性准备（每台新机器只配一次）

### 1.1 PyPI 凭证
发 pip 需要 `twine` 和一个 PyPI Token。

1. 安装工具：`python3 -m pip install --upgrade build twine`
2. 去 https://pypi.org/manage/account/token/ 生成 API Token（scope 选 `khy-os` 项目，或整账号）。
3. 写入 `~/.pypirc`：

```ini
[pypi]
  username = __token__
  password = pypi-XXXXXXXX你的token整段XXXXXXXX
```

> 权限收紧：`chmod 600 ~/.pypirc`。
> 验证：`twine check`（在有 dist/ 时）应能跑通；`python3 -m twine --version` 能打印版本即装好。

### 1.2 npm 凭证（只有要发 npm 渠道才需要）
1. 安装 Node ≥ 20、npm。
2. `npm login`（或在 CI 用 `NPM_TOKEN`）。
3. 验证：`npm whoami` 能打印你的用户名 = 已登录。脚本预检会卡这一步。

> 只发 pip 的话，加 `--skip-npm`，就不需要 npm 登录。

---

## 2. 版本号住在哪里（4 个文件，脚本会自动同步）

`publish-dual.sh` 接受版本号后，自动改这 4 处，你**不用手改**：

| 文件 | 作用 |
|---|---|
| `pyproject.toml` `[project] version` | **pip 构建的真源**（wheel/sdist 的版本由它决定） |
| `platform/khy_platform/__init__.py` | 运行时 `__version__`——其实是 `_detect_version()` 动态读取（先读已安装元数据，再回退读最近的 `pyproject.toml`），**没有硬编码常量**，所以只要 pyproject 对了它就对 |
| `packaging/npm/package.json` `version` | npm 渠道 `@khy-os/khy-os` 的版本 |
| `services/backend/package.json` `version` | `khy --version` 报告的版本 |

> 校验：仓库里有 `npm run check:version-sync` 检查这几处是否一致；CI 发布前会自动跑。

---

## 3. 标准发布流程（推荐：用脚本）

### 步骤
```bash
# 1) 确认在干净的工作区、对的分支上
git status

# 2) 先彩排（不上传）
bash scripts/release/publish-dual.sh 0.1.126 --dry-run

# 3) 彩排全绿后，真发 + 打 tag + 推送
bash scripts/release/publish-dual.sh 0.1.126 --tag --push -y
```

### 脚本选项速查
| 选项 | 含义 |
|---|---|
| `<version>` 或 `--version X.Y.Z` | 目标版本号（首位置参数即可） |
| `--dry-run` | 构建+审计全跑，但**不上传**、不打 tag（`twine check` / `npm publish --dry-run`） |
| `--skip-pip` | 只发 npm |
| `--skip-npm` | 只发 pip |
| `--test-pypi` | pip 上传到 **TestPyPI** 而非正式 PyPI（演练真实上传用） |
| `--no-isolation` | 不用 build 隔离构建 wheel/sdist（离线/无法联网装构建依赖时用） |
| `--tag` | 发布成功后提交版本号改动 + 打注解 tag `vX.Y.Z` |
| `--push` | 推送分支和 tag 到远端（隐含 `--tag`） |
| `--remote NAME` | 推送到哪个远端（默认 origin，否则第一个配置的远端） |
| `-y` / `--yes` | 不交互确认，直接执行 |

### 审计门禁是什么
"纯净度审计"= 保证打出来的 sdist/wheel **不含** `.iso`、`node_modules`、外部依赖树；**必须含** 内核源码 + `kernel/vendor` + `kernel/iso/boot/limine/limine.conf` + 钉死的工具链 manifest。任一渠道审计失败，**在上传前**就整体中止，不会发出半成品。

---

## 4. 手动两步法（不想用脚本、或脚本坏了时的兜底）

脚本本质就是下面这两步（pip 侧），可以手动复刻：

```bash
# 第 1 步：构建 + 纯净度审计（只构建审计，不上传）
bash scripts/release/build-and-audit-pip-purity.sh --no-isolation
#   产物落在 dist/ ：khy_os-<版本>-py3-none-any.whl 和 khy_os-<版本>.tar.gz
#   审计行打印 “PURE” 即干净

# 第 2 步：上传到 PyPI
python3 -m twine upload dist/*
```

> 注意：手动法**只发了 pip**。npm 渠道（`@khy-os/khy-os`）需另外 `cd packaging/npm && npm publish --access public`（先 `npm run prepack` 组装）。
> 手动法**也不会**自动同步那 4 个版本文件，发布前要先手改 `pyproject.toml` 等（见 §2），否则打出来还是旧版本号。

### 验证发布成功
PyPI 的聚合 JSON 接口有缓存延迟，**别只看项目主页**。用**按版本**接口确认最快：
```bash
curl -s https://pypi.org/pypi/khy-os/0.1.126/json | head -c 200
#   返回 200 + 该版本 JSON = 已上线；404 = 还没上去或还在同步
pip install khy-os==0.1.126     # 能装上即真上线
```

---

## 5. CI 发布（GitHub Actions，最省心、可审计）

仓库有 `.github/workflows/release.yml`，手动触发即可发布，**不需要本机配凭证**（凭证在仓库 Secrets 里）。

1. 先把版本号改好并合进目标分支（或让脚本 `--tag --push` 推上去）。
2. GitHub → Actions → **Release** → **Run workflow**，填：
   - `ref`：从哪个分支/tag/SHA 发；
   - `publish_pypi`：勾上（需仓库已配 `PYPI_API_TOKEN` Secret）；
   - `dry_run`：先勾上试跑一次，确认无误再关掉真发。
3. 它会从 `pyproject.toml` 解析版本、跑 `check:version-sync`、构建、`twine upload`、建 GitHub Release 并打 `v<版本>` tag。

> 前置：仓库 Settings → Secrets 里要有 `PYPI_API_TOKEN`（npm 渠道则需 `NPM_TOKEN`）。

---

## 6. 发布前自查清单（机械照勾）

- [ ] 工作区干净 `git status`，在正确分支上
- [ ] 想好新版本号（语义：补丁位 +1，如 0.1.125 → 0.1.126）
- [ ] `--dry-run` 彩排通过（pip 审计 PURE / npm 审计通过）
- [ ] 凭证就绪：`twine` + `~/.pypirc`（pip）；`npm whoami` 已登录（npm，仅双渠道时）
- [ ] 真发：去掉 `--dry-run`，加 `--tag --push -y`
- [ ] 验证：`curl .../pypi/khy-os/<版本>/json` 返回 200 + `pip install khy-os==<版本>` 成功
- [ ] （双渠道）`npm view @khy-os/khy-os version` 显示新版本

---

## 7. 常见坑

| 现象 | 原因 / 解法 |
|---|---|
| PyPI 主页还显示旧版本 | 聚合接口缓存延迟；查**按版本**接口 `/pypi/khy-os/<版本>/json` 才准 |
| `twine upload` 报 400 文件已存在 | 该版本号已发过，PyPI 不允许覆盖；**版本号 +1 重发** |
| 构建依赖装不上 / 离线 | 加 `--no-isolation` 用本地已装依赖构建 |
| npm 预检失败 `npm whoami` | 没登录；`npm login`，或只发 pip 加 `--skip-npm` |
| 审计 FAIL 提到 `.iso`/`node_modules` | 包里混进了不该有的产物；别强发，先查 `MANIFEST.in`（用 `python scripts/release/render_manifest.py` 重生，**勿手改**） |
| `khy --version` 和 PyPI 版本对不上 | `services/backend/package.json` 没同步；用脚本发布会自动同步，手动法要记得改 |

---

## 8. 相关文件索引

- 发布脚本（双渠道，单一真源）：`scripts/release/publish-dual.sh`
- pip 构建+审计（手动法第 1 步）：`scripts/release/build-and-audit-pip-purity.sh`
- MANIFEST 重生（确定性，勿手改）：`scripts/release/render_manifest.py`
- 打包规则真源：`scripts/release/pip_packaging_rules.py`
- 版本一致性校验：`npm run check:version-sync`
- CI 发布工作流：`.github/workflows/release.yml`
- 安装布局参考：`[OPS-MAN-022] pip-安装布局参考.md`
- pip 安装后完整还原：`[OPS-MAN-037] pip安装后-完整还原与全功能开启指南.md`
