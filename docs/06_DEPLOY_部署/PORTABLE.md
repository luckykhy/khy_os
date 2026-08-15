# Khy-OS 便携化使用指南

Khy-OS 有两条不同的便携路径，请按用途选择：

## 直接压缩源码文件夹（原样源码包）

如果只是要把当前开发环境整体传给另一台机器，直接在 Windows 资源管理器中对整个 `khy-os` 文件夹右键，选择“压缩为 ZIP 文件”即可。这个操作不需要先运行 npm 命令，也不需要执行 `打包便携版.bat`。

解压时保留最外层 `khy-os` 目录和全部子目录。无需注册全局命令时，可直接从解压后的目录启动：

```powershell
cd <解压后的 khy-os>
.\khy.bat --help
```

希望在任意目录使用 `khy` 命令时，Windows 双击根目录的 `portable-setup.bat`（或在终端运行 `.\portable-setup.bat`）。脚本会安装 `khy`、`khy-os`、`khyquant` 三个命令包装器到 `%LocalAppData%\khy-os\bin`，并幂等加入当前用户 PATH。打开新终端后运行：

```powershell
khy --help
```

Linux/macOS 可运行：

```sh
bash portable-setup.sh
khy --help
```

Unix 配置默认将包装器安装到 `~/.local/bin`，并在 `.bashrc` 或 `.zshrc` 中维护唯一的 Khy-OS PATH 配置块。项目目录移动、盘符变化或重新解压到其他位置后，在新目录再次运行对应的 `portable-setup` 脚本即可刷新包装器目标。

不希望修改用户 PATH 时，Linux/macOS 也可直接启动：

```sh
cd <解压后的 khy-os>
./khy.sh --help
```

配置脚本写入用户 PATH 和命令包装器属于使用者主动执行的命令注册操作。Khy-OS 日常便携启动的数据仍位于源码根的 `.khy/`，不会因此改写到宿主 HOME、APPDATA 或其他系统数据目录。

源码入口从自身脚本位置解析项目根目录，支持移动到其他盘符以及包含空格或中文的路径。也可以从任意工作目录调用绝对路径入口。源码便携模式的状态默认位于源码根的 `.khy/`，不会因为调用者当前目录改变。

这是“原样压缩”，压缩包会忠实包含压缩时源码目录中已有的所有内容，包括 `node_modules/`、`.khy/`、缓存、日志、数据库和本地配置；不会自动清理、裁剪或重排。若目录中含有个人凭据或运行状态，请在压缩前自行处理。该方式适合继续开发和保留当前工作区，不等同于面向终端用户的发布包。

## 发布版一键打包

需要生成经过裁剪、清单记录、SHA-256 校验并带内置运行时的发布 ZIP 时，使用发布打包入口：

- Windows 双击 `打包便携版.bat`
- `npm run portable:package`
- `npm run portable:package:runtime`
- `npm run portable:package:dev`

发布版流程会组装独立的 `portable-runtime` 或 `portable-dev` artifact，并执行健康检查后再压缩。它与上面的源码目录原样压缩是两条独立路径。

Windows 本机构建的运行版默认输出到：

```text
dist/releases/portable-runtime-<version>-win-x64.zip
```

命令行等价入口：

```powershell
npm run portable:package
# 或
npm run portable:package:runtime
```

生成可复制到 U 盘继续开发的开发版：

```powershell
npm run portable:package:dev
```

输出为 `dist/releases/portable-dev-<version>-win-x64.zip`。开发版包含项目源码、已安装依赖、同平台 Node/Python 运行时和 npm/pip 离线缓存。复制 ZIP 到 U 盘并解压后，运行：

```powershell
.\launch.bat shell
```

这会从便携包的 `source` 目录打开开发终端。该终端的 Node、Python、依赖缓存、应用数据、日志和临时目录均指向便携包内部；可在盘符变化以及包含空格或中文的目录中使用。直接运行 `.\launch.bat --help` 则启动开发版应用入口。

本机入口只生成当前 Windows/x64 产物。Linux、macOS Intel 和 macOS Apple Silicon 发布包由 GitHub Actions 的对应原生 runner 分别生成。`--skip-build` 可复用已有前端构建输出，`--keep-artifact` 可在压缩后保留 `dist/portable` 下的展开目录，自定义 ZIP 输出目录使用 `--out <dir>`。

## 支持平台

每个产物只支持一个 OS/CPU 组合：

| 产物后缀 | 系统 | 架构 |
|---|---|---|
| `win-x64` | Windows | x64 |
| `linux-x64` | Linux | x64 |
| `macos-x64` | macOS | Intel x64 |
| `macos-arm64` | macOS | Apple Silicon arm64 |

不得在不同平台间复制 `node_modules`、原生模块或嵌入式运行时混用。CI 在上述四个平台的原生 runner 上分别构建和验证运行产物。

## 使用 portable-runtime

解压与当前平台匹配的 `portable-runtime-<version>-<platform>/` 后直接运行：

```powershell
# Windows
.\launch.bat --help
```

```sh
# Linux / macOS
./launch.sh --help
```

启动器只为当前进程设置环境变量，不修改系统配置。产物可整体移动到其他目录、盘符以及包含空格或中文的路径，再从新位置运行同一启动器。

目录结构：

```text
portable-runtime-<version>-<platform>/
├── services/backend/     后端运行代码
├── platform/             共享平台包
├── software/khyquant/    量化后端运行代码
├── node_modules/         已安装运行依赖
├── runtime/node/         同平台 Node.js 运行时
├── runtime/python/       同平台 Python 运行时
├── web/ai/               AI 前端构建产物
├── web/quant/            量化前端构建产物
├── config/env.example    可选运行参数示例
├── state/.khy/           本产物的持久状态根
├── .portable             便携部署标记
├── BUILD-INFO.json       构建来源和工具链信息
├── MANIFEST.json         文件清单、目标平台和运行时合同
├── SHA256SUMS            清单及载荷摘要
└── launch.bat|launch.sh  相对路径启动器
```

## 使用 portable-dev

解压与当前平台匹配的 `portable-dev-<version>-<platform>/` 后运行：

```powershell
# Windows
.\launch.bat --help
```

```sh
# Linux / macOS
./launch.sh --help
```

开发产物内置运行时和离线缓存。正常启动不读取宿主 Python/Node，也不要求修改 PATH。源码位于 `source/`；Windows 使用 `.\launch.bat shell`、Linux/macOS 使用 `./launch.sh shell` 进入便携开发终端，构建和依赖命令应在该环境中执行。

目录结构：

```text
portable-dev-<version>-<platform>/
├── source/               完整 workspace、源码和依赖
├── runtime/node/         同平台 Node.js 22.12.0
├── runtime/python/       同平台嵌入式 Python
├── caches/npm/           npm 离线缓存
├── caches/pip/           pip 离线缓存或 wheels
├── artifacts/            本地构建输出目录
├── state/.khy/           本产物的持久状态根
├── .portable
├── BUILD-INFO.json
├── MANIFEST.json
├── SHA256SUMS
└── launch.bat|launch.sh
```

离线开发的边界由 `package-lock.json`、已携带的依赖和缓存决定。新增一个未缓存的依赖仍需要预先补充缓存并重新构建产物。

## 构建产物

### 构建 portable-runtime

推荐使用上文的一键入口：

```sh
npm run portable:package:runtime
```

以下分步命令用于 CI 说明和故障排查。先安装依赖并构建两个前端，再用当前平台的 Node/Python 运行时目录组装运行产物：

```sh
npm ci
npm ci --prefix apps/ai-frontend
npm ci --prefix software/khyquant/frontend
npm run build --prefix apps/ai-frontend
npm run build --prefix software/khyquant/frontend

npm run portable:build:runtime -- \
  --node-runtime RUNTIME_NODE_DIR \
  --python-runtime RUNTIME_PYTHON_DIR \
  --force
```

只查看目标、输入和缺失前置项：

```sh
npm run portable:plan:runtime
```

CI 的权威顺序为：安装目标平台 Node/Python、安装应用与前端依赖、构建前端、组装 runtime、校验产物、压缩并上传。

### 构建 portable-dev

推荐使用自动发现本机 Node、Python 与缓存的一键入口：

```sh
npm run portable:package:dev
```

需要固定运行时或缓存来源时，可显式提供同平台目录：

```sh
npm run portable:build:dev -- \
  --node-runtime RUNTIME_NODE_DIR \
  --python-runtime RUNTIME_PYTHON_DIR \
  --npm-cache NPM_CACHE_DIR \
  --pip-cache PIP_CACHE_DIR \
  --force
```

Windows PowerShell 可使用同样参数，不使用反斜杠续行：

```powershell
npm run portable:build:dev -- --node-runtime RUNTIME_NODE_DIR --python-runtime RUNTIME_PYTHON_DIR --npm-cache NPM_CACHE_DIR --pip-cache PIP_CACHE_DIR --force
```

规划检查：

```sh
npm run portable:plan:dev -- \
  --node-runtime RUNTIME_NODE_DIR \
  --python-runtime RUNTIME_PYTHON_DIR \
  --npm-cache NPM_CACHE_DIR \
  --pip-cache PIP_CACHE_DIR
```

构建器拒绝缺失的运行时、缓存、lockfile 或 workspace/前端依赖，并排除 `.env*`、数据库、日志、凭据、运行状态和旧输出目录。

## 校验与打包

构建完成后，先校验目录产物：

```sh
node scripts/portable/portable-health-check.js --artifact dist/portable/ARTIFACT_DIR
```

校验内容包括：

- `MANIFEST.json` schema、kind、OS 和 CPU；
- 每个载荷文件的大小与 SHA-256；
- `SHA256SUMS` 自身的路径集合、manifest 摘要和载荷摘要；
- 启动器、运行时、可执行文件和两个前端入口的完整性；
- 目标平台必须与执行校验的主机一致。

只有通过校验的 artifact 才能压缩：

```sh
node scripts/portable/pack-portable.js --artifact dist/portable/ARTIFACT_DIR
```

预览而不生成压缩包：

```sh
node scripts/portable/pack-portable.js --artifact dist/portable/ARTIFACT_DIR --dry-run
```

自定义压缩包输出目录：

```sh
node scripts/portable/pack-portable.js --artifact dist/portable/ARTIFACT_DIR --out dist/releases
```

打包器在压缩前重新验证 manifest，检测到文件缺失、篡改或额外摘要条目时立即终止。

## 数据与宿主隔离

启动器以自身所在目录为 `KHY_PORTABLE_ROOT`，并统一设置：

| 变量 | 便携产物中的值 |
|---|---|
| `KHY_PORTABLE_ROOT` | `<artifact>/` |
| `KHYQUANT_PORTABLE_ROOT` | `<artifact>/`，旧名称兼容 |
| `KHY_OS_ROOT` | runtime 为 `<artifact>/`；dev 为 `<artifact>/source/` |
| `KHY_DATA_HOME` | `<artifact>/state/.khy/` |
| `KHY_PROJECT_DATA_HOME` | 同 `KHY_DATA_HOME` |
| `KHYQUANT_DATA_HOME` | 同 `KHY_DATA_HOME`，旧名称兼容 |
| `KHYOS_HOME` | 同 `KHY_DATA_HOME` |
| `KHY_RUNTIME_HOME` | `<artifact>/state/.khy/runtime/` |
| `KHY_CACHE_HOME` | `<artifact>/state/.khy/cache/` |
| `KHY_LOG_HOME` | `<artifact>/state/.khy/logs/` |
| `KHY_TEMP_HOME` | `<artifact>/state/.khy/tmp/` |

在该启动环境内，应用不得向 `~/.khy`、`C:\.khyquant`、`APPDATA` 或 `LOCALAPPDATA` 写入 Khy-OS 状态。便携模式也不会写入宿主数据目录指针。若显式覆盖上述变量，覆盖目录由使用者自行管理，不再属于默认零宿主写入合同。

## 移动、备份与升级

1. 退出该便携实例，确保数据库和后台进程已关闭。
2. 复制整个 artifact 目录；需要保留状态时包含 `state/.khy/`。
3. 从新目录执行 `launch.bat` 或 `launch.sh`。
4. 运行 artifact health check，确认文件完整性和目标平台匹配。

`MANIFEST.json` 描述发布载荷，不包含运行后在 `state/` 中新增的用户状态。升级时建议解压新的只读产物，再显式复制或迁移旧 `state/.khy/`；不要用新压缩包直接覆盖正在使用的目录。

## 与源码启动的区别

仓库根目录的 `khy.bat`、`khy.sh`、`scripts/portable/run.ps1` 和旧同步脚本仍服务于源码开发、自举或兼容流程。它们不是可发布 artifact 的替代品，也不构成“目标机无预装运行时、离线启动”的交付证明。

发布和验收只以 `scripts/portable/build-portable-artifact.js` 生成、带完整 manifest 且通过 `portable-health-check.js --artifact` 的目录为准。

### 源码目录下的三种启动档位

<!-- 本小节由根目录 PORTABLE_GUIDE.md 归并而来（归档日期 2026-08-15）。 -->

把源码文件夹整份拷到另一台机器后，按「要不要 Web 界面」选档位：

| 启动方式 | 起了什么 | 需要后端 | Web 界面 |
| --- | --- | --- | --- |
| `khy` / `.\khy.bat` / `./khy.sh` | 仅 CLI（轻量） | 否 | 无 |
| `scripts\setup\start-backend.bat` | 后端 API + 认证 | 是 | 无（只有 API） |
| `scripts\setup\start-all.bat` | 后端 + 前端，各开一个窗口 | 是 | http://localhost:3000 |

后端 API 在 http://localhost:5000。三档都不需要先跑任何 setup 脚本来建账号——
**CLI 的自动登录不依赖后端**（凭据在本机现场生成），详见
`docs/07_OPS_运维/[OPS-MAN-175] 首次运行自动登录与凭据.md`。需要 Web 界面登录、
注册新用户或访问数据库时才必须起后端。

跨机器配置全局 `khy` 命令：运行 `portable-setup.bat`（Windows）/ `portable-setup.sh`，
重开终端后 `khy --version` 验证。脚本自动探测当前项目位置，不需要手写路径。

## 故障排除

### 目标平台不匹配

重新获取与当前 OS/CPU 对应的 artifact。macOS Intel 与 Apple Silicon 使用不同产物。

### manifest 或 SHA256SUMS 校验失败

不要继续运行该副本。重新复制或重新构建完整 artifact；不得只更新单个载荷文件后沿用旧摘要。

### 启动器找不到嵌入式 runtime

确认解压工具保留了完整目录层级；Linux/macOS 上确认 `launch.sh` 与 `runtime/node/bin/node` 具有执行权限。随后再次运行 health check。

### portable-dev 离线安装缺包

在可联网构建机补齐 npm/pip 缓存，并重新生成整个开发产物。不要把其他 OS/CPU 的 `node_modules` 或 Python 环境复制进来。

### 状态需要清空

退出所有 Khy-OS 进程后备份并删除 artifact 内的 `state/.khy/`，再运行启动器。该操作只重置当前便携实例。
