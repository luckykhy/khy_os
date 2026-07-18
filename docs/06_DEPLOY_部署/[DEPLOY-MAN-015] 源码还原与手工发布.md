<!-- 文档分类: DEPLOY-MAN-015 | 阶段: 部署 | 原路径: docs/指南/源码还原与手工发布.md -->
# 源码还原与手工发布

> 维护者文档。记录两件事：
> 1. **源码还原** —— 如何从已发布的 pip / npm 发行物（或已安装环境）取回完整的多语言工作坊源码。
> 2. **手工发布** —— 如何自己动手把 khy OS 同时发布到 PyPI（`khy-os`）与 npm（`@khy-os/khy-os`），不依赖 Claude 代劳。

日期：2026-06-10 · 适用版本：0.1.94+

相关文档：[pip 安装布局参考](../07_OPS_运维/%5BOPS-MAN-022%5D%20pip-安装布局参考.md) · [PyPI 发布手册 0.1.17–0.1.18](%5BDEPLOY-MAN-013%5D%20pypi-发布手册-0.1.17-0.1.18.md)（已归档）

---

## 1. 背景：双渠道、单一工作坊

khy OS 通过两个平行渠道发行，二者携带**完全一致**的多语言「工作坊」源码（Node 后端 + C/asm 内核 + MoonBit WASM SDK + 前端 dist + Python 胶水 + dev 工具链版本锁）：

| 渠道 | 包名 | 编排中枢 | 被自愈的「其他语言」 |
|------|------|----------|----------------------|
| pip  | `khy-os`  | Python | Node 运行时（npm）、C/MoonBit 工具链 |
| npm  | `@khy-os/khy-os` | Node   | Python 工具（pip）、C/MoonBit 工具链 |

npm 渠道的 `prepack`（`packaging/npm/scripts/assemble.js`）直接**复用 pip 渠道的 bundle**（`platform/khy_os/bundled/`），所以两边工作坊字节级一致。

> **纯净规则（重要）**：发行物里**不含**任何第三方依赖树（`node_modules` / `site-packages` / `_build` / `target` 等）和原生二进制（`*.o/.so/.bin/.elf/...`）。`*.wasm` 是例外（前端离线基线运行时资产，随包）。这意味着还原出来的是**纯源码**，运行前需要触发自愈拉取运行依赖（见 §6.3）。

---

## 2. 版本号的三处真源

每次发布前都要同步，三者必须一致（PyPI / npm 都拒绝重复发布同版本）：

| 文件 | 作用 |
|------|------|
| `platform/khy_platform/__init__.py` | pip **单一真源**，`setup.py` 动态读取（`__version__ = "X.Y.Z"`） |
| `packaging/npm/package.json` | npm 渠道清单的 `"version"` |
| `services/backend/package.json` | `khy --version` 实际读取的就是它，不同步会和发布版本对不上 |

`publish-dual.sh`（§4）会自动同步这三处；手工发布（§5）需手动改。

---

## 3. 发布前提（凭证）

```bash
# pip：~/.pypirc 配好 [pypi] 的 API token（已就绪则无需再做）
#   [pypi]
#   username = __token__
#   password = pypi-AgEN...     ← PyPI API token

# npm：scoped 包 @khy-os/khy-os 首次发布前必须登录
npm login            # 按提示输入账号 / 邮箱 / OTP
npm whoami           # 确认登录成功
```

> **源码不再加锁**：发布真实源码（`origin-code` / `git-push`）与还原（`khy restore`）都**不再需要任何密码**——发行物始终内嵌完整真实源码（用固定默认密钥加密），`khy restore` 会自动解密。仅当还原**由自定义密钥加密的旧快照**时才需 `--secret <密钥>` / `KHY_SOURCE_PUBLISH_SECRET`。模型导出（`train export` / `train upload`）同样已取消密码，学习模式（`/study on`）也不再需要密码。

---

## 4. 一键双渠道发布（推荐）

脚本：`scripts/release/publish-dual.sh`。**审计门控**——两个渠道审计全绿之前不上传任何东西；任一审计失败立即中止。

```bash
cd /home/kodehu03/Khy-OS

# 正式双发（会先打印发布计划并要求确认）
bash scripts/release/publish-dual.sh 0.1.95

# 彩排：改版本号 + 跑完整构建/审计，但只 twine check / npm --dry-run，不真正上传
bash scripts/release/publish-dual.sh 0.1.95 --dry-run

# 发布成功后：提交版本改动 + 打 annotated tag v0.1.95
bash scripts/release/publish-dual.sh 0.1.95 --tag

# 再 push 分支 + tag 到 remote（--push 自动隐含 --tag；默认 origin，否则第一个 remote）
bash scripts/release/publish-dual.sh 0.1.95 --push
```

### 全部开关

| 开关 | 作用 |
|------|------|
| `<version>` / `--version X.Y.Z` | 目标版本（位置参数或具名皆可） |
| `--dry-run` | 全流程构建 + 审计，但不上传（`twine check` + `npm publish --dry-run`），也不 tag/push |
| `--skip-pip` | 只发 npm |
| `--skip-npm` | 只发 pip |
| `--test-pypi` | pip 上传到 TestPyPI 而非正式 PyPI |
| `--no-isolation` | 离线构建 wheel/sdist（复用已装的 build/setuptools/wheel，不解析网络） |
| `--tag` | 发布成功后提交版本改动 + 打 annotated tag `vX.Y.Z`（仅本地） |
| `--push` | 额外把分支与 tag push 到 remote（隐含 `--tag`） |
| `--remote NAME` | 指定 push 的 remote |
| `-y` / `--yes` | 跳过确认提示 |

### 执行流程

1. **Preflight**：检查 `python3/twine`（pip）、`node/npm`（npm）、`perl`、`git`（仅 `--tag/--push`）；正式发布强制 `npm whoami` 必须通过；`--tag` 时校验 `vX.Y.Z` 不存在、remote 存在。
2. **版本同步**：写入 §2 的三处真源。
3. **审计门控**：先 `build-and-audit-pip-purity.sh`（隔离构建 + 纯净/完整审计），再 `npm run audit:purity && npm test`。
4. **依次发布**：`twine upload` → `npm publish --access public`。
5. **可选 git**：提交版本改动 → annotated tag → push（仅在真实发布且带 `--tag/--push` 时）。

---

## 5. 手工分步发布（兜底）

当不想用一键脚本，或需要逐步排查时，按下面两步走。

### 5.1 改版本号

把 §2 的三个文件里的版本号改成新版本（例如 `0.1.95`）。

### 5.2 发布 pip（`khy-os`）

```bash
cd /home/kodehu03/Khy-OS

# (1) 隔离构建 + 纯净/完整双审计
bash scripts/release/build-and-audit-pip-purity.sh
#   网络不通时离线兜底：
#   KHY_OFFLINE_BUILD=1 bash scripts/release/build-and-audit-pip-purity.sh --no-isolation

# (2) 审计全绿后上传
python3 -m twine upload dist/*
#   先在 TestPyPI 演练：python3 -m twine upload --repository testpypi dist/*
```

### 5.3 发布 npm（`@khy-os/khy-os`）

```bash
cd /home/kodehu03/Khy-OS/packaging/npm

# (1) 纯净 + 完整审计（内部 npm pack 触发 prepack 组装工作坊）+ 单测
npm run audit:purity
npm test

# (2) 审计绿后发布；scope 包首次必须带 --access public
npm publish --access public
#   先彩排：npm publish --dry-run
```

> ⚠️ `prepack`（`assemble.js`）在**维护端**需要 Python（它复用 pip bundle，缺失时会 `python setup.py build_py` 建一次）。终端用户安装时是纯 Node。

---

## 6. 源码还原

发行物携带完整工作坊源码，可在**无源码 checkout** 的情况下取回。

### 6.1 从 pip 发行物还原

发行布局：

- **sdist**（`*.tar.gz`）：**原始源码布局** —— `kernel/Makefile`、`kernel/src`、`kernel/boot`、`platform/khy_platform/_resources/dev-constraints.txt` 等，直接对应仓库目录结构。最干净的还原源。
- **wheel**（`*.whl`）：**安装态布局** —— 工作坊在 `khy_os/bundled/...`，Python 胶水在 `khy_platform/`。

```bash
# 方式 A：只下载源码分发（sdist），解压即得完整原始工作坊
pip download khy-os --no-deps --no-binary :all: -d /tmp/khy-src
tar -xzf /tmp/khy-src/khy_os-*.tar.gz -C /tmp/khy-src
ls /tmp/khy-src/khy_os-*/         # kernel/ services/ platform/ ...

# 方式 B：下载 wheel 并解压（取 bundled 工作坊）
pip download khy-os --no-deps -d /tmp/khy-whl
unzip -q /tmp/khy-whl/khy_os-*.whl -d /tmp/khy-whl/x
ls /tmp/khy-whl/x/khy_os/bundled/   # 同一份工作坊

# 方式 C：从已安装环境定位
python3 -c "import khy_platform; print('glue   :', khy_platform.INSTALL_PATH)"
python3 -c "import khy_os, os; print('bundle :', os.path.join(os.path.dirname(khy_os.__file__), 'bundled'))"
```

### 6.2 从 npm 发行物还原

发行布局：tarball 根为 `package/`，工作坊在 `package/bundled/...`；安装后位于 `node_modules/@khy-os/khy-os/bundled/...`。

```bash
# 方式 A：直接拉取已发布 tarball 并解压
npm pack @khy-os/khy-os --pack-destination /tmp/khy-npm
tar -xzf /tmp/khy-npm/khy-os-*.tgz -C /tmp/khy-npm
ls /tmp/khy-npm/package/bundled/    # services/backend kernel platform ...

# 方式 B：从已安装环境定位（index.js 在包入口导出绝对路径）
node -e "const m=require('@khy-os/khy-os'); console.log('install:', m.getInstallPath()); console.log('bundle :', m.getBundleRoot()); console.log('backend:', m.getBackendDir());"
```

### 6.3 还原后重建运行依赖（self-heal）

因纯净规则不含 `node_modules`，还原出来的工作坊**不能直接运行**，需触发自愈拉取运行依赖：

```bash
# pip 渠道：安装期自愈（也可在首次启动时自动触发）
khy postinstall            # 等价于 khy_platform.run_postinstall()
khy dev-setup              # 编译期：补 Python dev 工具 + 检测 C/MoonBit 工具链

# npm 渠道：postinstall 在 `npm install @khy-os/khy-os` 时已自动跑；手工兜底：
node node_modules/@khy-os/khy-os/bin/khy.js postinstall
node node_modules/@khy-os/khy-os/bin/khy.js dev-setup
```

自愈遵守「永不中断」硬契约：任何依赖拉取失败都会被 catch、打印可复制的手动恢复命令、并返回 0（npm 渠道尤其关键——非 0 的 postinstall 会中断整个 `npm install`）。

---

## 7. 发布后验证

```bash
# pip
pip install --upgrade khy-os && khy --version

# npm（全新目录里装，验证 postinstall 自愈真的跑）
mkdir -p /tmp/verify && cd /tmp/verify && npm init -y >/dev/null
npm install @khy-os/khy-os && npx khy --version
```

`khy --version` 应输出刚发布的版本号（即 §2 第三处真源同步后的值）。

---

## 8. 常见坑

1. **重复版本被拒**：PyPI / npm 都不允许重发同版本号 —— 先升 §2 三处真源。
2. **`khy --version` 与发布版本不符**：忘了同步 `services/backend/package.json`。`publish-dual.sh` 会自动处理。
3. **npm scope 包首发报权限错**：首次必须带 `npm publish --access public`。
4. **`prepack` 在维护端报缺 Python**：npm 渠道构建复用 pip bundle，维护机需 Python3；终端用户安装不需要。
5. **审计报含 `node_modules`/`_build`**：多为工作树里**未跟踪**的构建产物被扫入分发。pip 端靠 `MANIFEST.in` 显式 prune + 审计兜底；npm 端靠 `assemble.js` 的 `PRUNE_DIRS` + `.npmignore`。
6. **`*.wasm` 被误判**：`*.wasm` 是合法的离线基线资产，审计脚本已豁免；若报错检查是否在 `_build/target` 缓存目录下（那是目录规则命中，删缓存即可）。
