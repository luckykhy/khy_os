# entries/ — Khy 多端入口

> **这个目录回答一个问题**：khy 有哪些端、每个端的入口在哪、怎么起、怎么构建、现在能不能用。
>
> 本目录是**真源（数据）**；读写它的实现在
> `services/backend/src/services/entrypoints/`（见下方「表与代码为什么分居两处」）。
> 规范真源是 [`[DESIGN-ARCH-117] khy 多端入口矩阵`](../docs/03_DESIGN_设计/DESIGN-ARCH/%5BDESIGN-ARCH-117%5D%20khy-多端入口矩阵.md)。

---

## 先看这个：exe / apk / html 在哪

**本目录既是索引，也是构建产物的唯一根。** 按 `[DESIGN-LAY-004]`（LAYOUT-005，构建产物单一根），
一切可再生构建产物落 `entries/<producer>/`（2026-09-18 迁移，原为仓库根 `_build/`）。
本目录里**提交的**只有三件索引文件（`entries.json` / `launch.js` / `README.md`），
余下 `entries/*` 子目录一律 gitignore（`.gitignore` 用「`entries/*` + 逐条 `!` 白名单」实现）。

| 形态 | 日常入口 | 可分发力产物 | 产物坐标真源 |
| --- | --- | --- | --- |
| 终端 shell | ✅ `khy.bat` / `khy.sh` / `khy-cli.bat`（现在就有） | pip wheel / npm tarball | `BUILD-OUTPUTS.json` 的 `pip-dist` |
| 桌面端 exe | 无（需先构建） | electron-builder 安装包 | `electron-builder` |
| 手机端 apk | 无（需先构建） | `app-release.apk` + `.aab` | `flutter-android-release` |
| 网页端 html | 无（需先构建） | Vite 静态站 | `ai-frontend` |

**想立刻知道每个端的产物到底在不在、怎么得到它**：

```text
khy entry status            或    node entries/launch.js status
```

它把 `BUILD-OUTPUTS.json` 的登记换成人话：形态 → 产物落点 → **磁盘上有没有** → **一条得到它的命令**。

> **注意：产物子目录目前大多还不存在**（`BUILD-OUTPUTS.json` 里的条目状态全是 `migrating`）。
> 也就是说：产物登记表已经写好、根已迁到 `entries/`，但各工具的 `outDir` 尚未逐一切过来——
> **四端里只有终端是现成可用的**，exe / apk / html 都要先构建一次，且构建产物仍落在各包的旧路径，
> 待 §8 步骤 2 迁移后才真正收进 `entries/<producer>/`。

## 两条进入方式

```text
khy entry list                      经 khy CLI（Python 启动器 或 khy-cli.bat 均可）
node entries/launch.js              经本目录的跨平台壳（只要 Node，不要 Python）
```

| 方式 | 依赖 | 适用 |
| --- | --- | --- |
| `khy entry ...` | Python 3.8+ 或 Node 20+ | 日常；CLI 的完整命令面 |
| `node entries/launch.js ...` | **只要 Node 20+** | 便携/裸目录；没有 Python；`khy-cli.bat` 在非 Windows 上不可用 |

两者是同一个真源的两种读法，不各自维护一份端清单。

---

## 端清单

| 端 id | 类型 | 形态 | 状态 | 来源 |
| --- | --- | --- | --- | --- |
| `cli` | cli | shell | 就绪 | `platform/khy_platform` |
| `cli-node` | cli | shell | 就绪 | `services/backend` |
| `desktop` | desktop | exe | 就绪 | `apps/khyos-desktop` |
| `desktop-legacy` | desktop | exe | 降级 | `electron/` |
| `desktop-provider-hub` | desktop | exe | 降级 | `apps/provider-hub` |
| `web` | web | html | 就绪 | `apps/ai-frontend` |
| `web-quant` | web | html | 就绪 | `software/khyquant/frontend` |
| `mobile` | mobile | apk | 就绪 | `apps/khy-os-client-app` |
| `mobile-legacy` | mobile | apk | **损坏** | `apps/khy-mobile` |

**表不会自己更新**：它是**人工定档**。哪个端改了指路方式、换了源目录、补上了打包配置，
就要改 `entries.json`。不确定现状时跑这三条——它们分别回答三个不同的问题，别混：

| 命令 | 回答的问题 | 读什么 |
| --- | --- | --- |
| `khy entry list` | 端声明了什么 | `entries.json` |
| `khy entry status` | **产物在哪、产出来没有** | `entries.json` + `BUILD-OUTPUTS.json` + 磁盘 |
| `khy entry probe` | 端能不能跑起来（源/标记/工具链/构建档） | 磁盘 + 本机 PATH |

---

## entries.json 的四条硬约束

改这张表时，有四件事**不许写**：

| 不许写 | 为什么 | 该怎么写 |
| --- | --- | --- |
| 端口字面量 | 工程规则 1（`RUNTIME-001`）红线 | `ports[].ref` 写 `serviceDefaults` 的**导出名**，如 `"WEB_FRONTEND_PORT"` |
| 绝对文件系统路径 | 同上 | 仓库相对路径，或 `<appRoot>` 占位符 |
| 产物路径 | 会与 `docs/10_规范/registry/BUILD-OUTPUTS.json` 形成第二份真源 | `artifactOutput` 存那张表的 **id 指针** |
| 猜出来的启动命令 | 猜错比拒绝更贵 | 没有就写 `null`，诚实地报「未声明」 |

改完自检（在**仓库根**执行）：

```bash
node services/backend/node_modules/jest/bin/jest.js \
  --config services/backend/jest.config.js --rootDir services/backend \
  tests/entrypoints.test.js
```

21 条契约测试锁的就是上面这四件事（数据自洽、无端口字面量、无绝对路径、解析不崩）加产物坐标解析，
外加四条**实测踩过的回归**——其中一条是「`--dry-run` 被静默忽略、真的去拉起了 Electron」，
另一条是「`spawn` 还没成功就报『已转入后台运行』的假成功」。改动 launcher 或 handler
之前先看那四条。

---

## 目录内容

| 文件 | 是什么 |
| --- | --- |
| `entries.json` | **单一真源**。9 个端条目 × 平台档 × 定档状态 |
| `launch.js` | 跨平台入口壳：`node entries/launch.js [status\|probe\|info\|<id>] [--build] [--dry-run]` |
| `README.md` | 本文件。人读的端地图 |

## 表与代码为什么分居两处

| 放哪 | 放什么 | 为什么 |
| --- | --- | --- |
| `<root>/entries/` | 表（数据）、人读地图、入口壳 | 要能被 Python 启动器、Node CLI、脚本、文档**同时按路径读**；埋进任何一层的实现目录都会让其余读取方绕路或违反禁止边 |
| `services/backend/src/services/entrypoints/` | `registry.js` / `probe.js` / `launcher.js` / `index.js` | 含 `child_process`，是 Node 业务逻辑 —— 按 `[DESIGN-LAY-005]` §6 第 3 条只能落 `services/` |

根 `entries/` 登记在 `[DESIGN-LAY-005]` §1.2 横切层（该层「不参与 L0–L6 的依赖判定」），
守卫侧对应 `scripts/ci/check-repo-layout.js` 的 `CROSSCUTTING`。**改本节须同步改那两处**，
否则 `layer-registry`（error 级）会判定存在未登记顶层目录。

---

## 现状里的两个坑（已知，未收口）

1. **`mobile-legacy` 是幽灵端**：`apps/khy-mobile` 里没有 `package.json` / `src` / `gradlew` /
   `build.gradle`，它自己的 `MANIFEST_MISSING.md` 已声明不可构建；但
   `services/backend/src/services/crossPlatform/crossLauncher.js` 与
   `platform/khy_platform/android_build.py` **两处在产代码路径仍指向它**。收口二选一：
   改指 `apps/khy-os-client-app`，或补齐工程。
2. **两条桌面线产不出可分发的 exe**：`desktop-legacy`（根 `electron/`）与
   `desktop-provider-hub` 都没有 electron-builder 配置。要么补配置，要么把条目降为 `planned`。

完整清单见规范文档 §七「未完成的收口」。
