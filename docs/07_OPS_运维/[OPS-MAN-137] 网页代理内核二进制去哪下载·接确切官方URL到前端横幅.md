# [OPS-MAN-137] 网页代理内核二进制去哪下载 · 把确切官方 URL 接到前端横幅

> 送别礼收尾之一(用户诉求 2026-07-13:「网页中代理的二进制要去哪里下载」)。
> 类别:**能力存在但没接线**(数据在 SSOT 里,却没接到人面前)。

## 断桥(真实缺口)

`proxyCoreInstaller.js` 是 mihomo 内核**自动下载的单一真源**:
- 固定版本 `PINNED_VERSION = 'v1.18.10'`
- 官方固定资产基址 `RELEASE_BASE = github.com/MetaCubeX/mihomo/releases/download/<ver>`
- 逐平台资产表 `ASSETS`(linux/darwin/win32 × x64/arm64)
- 落地路径 `~/.khyquant/bin/mihomo`

**但确切下载 URL 从没接到任何人可见的面**:

| 面 | 接线前 | 问题 |
| --- | --- | --- |
| 前端横幅 `ProxyManagement.vue` | "请下载 mihomo 内核放到 `~/.khyquant/bin/`" | **从不说去哪下** |
| 后端 core-missing 指引 `proxyCoreManager.js:157` | "请下载 mihomo(clash-meta)内核放到 …/bin/" | **不含 URL** |

小白/离机用户对着"请下载 mihomo"四个字发懵——URL 明明就在仓库里(installer 的 ASSETS + RELEASE_BASE),只是没接出来。

## 修法(全 additive,门 `KHY_PROXY_CORE_DOWNLOAD_HINT` default-on)

三层接线,SSOT 单点扩展,零路由/成败判定改动:

1. **SSOT 叶暴露描述符** `proxyCoreInstaller.describeCoreDownload(platform?, arch?)`(纯函数·零 IO·绝不抛):
   复用既有 `resolveAsset` / `_binaryPath` / `PINNED_VERSION`,返回
   `{ supported, version, url, assetFile, kind, dest, binDir, releasesPage, platform, arch }`。
   - 受支持平台 → 确切官方固定 URL + 资产名 + 落地路径。
   - 冷门平台 → `supported:false` 但**仍给** releases 总页 + 落地路径(绝不留死路)。

2. **coreManager 接线**(门 `KHY_PROXY_CORE_DOWNLOAD_HINT`):
   - `getStatus(env)` 附 `download` 描述符(fail-soft:门关→null / installer 抛→null,不拖垮 status)。
   - `_coreMissingResult(installAttempt, env)`:门开且受支持 → guidance **直接含确切 URL**;
     门关/冷门平台 → **逐字节回退**旧无 URL 文案。附结构化 `download` 字段供前端消费。

3. **前端横幅接线** `ProxyManagement.vue`:
   - 派生 `coreDownload = egressStatus.coreStatus.download`。
   - 内核未装横幅:显示可点下载 URL(`<a target=_blank>`)+ 版本 + 落地目录 `<code>` + **一键复制**(`copyText`)。
   - 无描述符(门关/冷门平台)→ 回退到"官方 releases"通用兜底链接。

4. **flagRegistry** 登记 `KHY_PROXY_CORE_DOWNLOAD_HINT`(default-on parent,off:CANON)。

## 验证门(全绿)

```
node --check ×6(installer/manager/flagRegistry/两测/wiring 测)     OK
test:maintainer:proxy-egress                                        91/91 pass fail0
  ├─ describeCoreDownload 4 例(支持/win32-zip/冷门/缺省探测)
  ├─ getStatus.download 门开/门关/抛异常 fail-soft 3 例
  └─ core-missing guidance 含 URL(门开)/ 回退无 URL(门关)2 例
前端 build --prefix apps/ai-frontend                                ✓ 6.61s exit0(SFC 语法门)
useProxies.egress.wiring.test.js                                    11/11(+2 新:横幅 URL/dest/copyText 接线 · 冷门兜底链接)
arch:god                                                            我改文件全 <2500(最大 flagRegistry 2366);4 超限 pre-existing 我不在列
check:node-syntax                                                   4328 files passed
change-safety(显式 positional 7 文件)                              exit0 · 自动 surface test:maintainer:proxy-egress + 前端 build = map 桥闭合
agent-rules(显式 7 文件)                                           0 error 1 warn(proxyCoreManager:324 SIGKILL fixed-timeout = pre-existing,不在我 diff)
leaf-contract                                                       passed
flag-registry                                                       structurally sound
maintainer:check                                                   REAL_EXIT=0(proxy-egress 全 paths OK)
```

## 门关回退语义(向后兼容坐实)

`KHY_PROXY_CORE_DOWNLOAD_HINT=0` → `getStatus.download=null`、core-missing guidance 逐字节回退旧无 URL 文案、
core-missing 结果无 `download` 字段。旧消费者(仅读 `reason`/`guidance`)完全不受影响。
既有 core-missing 测试注入的 installer 只有 `install` 无 `describeCoreDownload` → `_coreDownload` catch 返 null → 旧文案保留,零回归。

## 教训

1. 「能力存在但没接线」= 数据在 SSOT 却没接到人面前;判据 = 前端/后端都说"下载 X"却从不给 URL,而 URL 明明是仓库常量。
2. SSOT 单点扩展(installer 加纯叶描述符)优于到处硬编码 URL——自动下载与人可读指引走同一真源,版本 bump 只改一处。
3. 冷门平台绝不留死路:无预置资产也给 releases 总页 + 落地路径。
4. 门关逐字节回退 + fail-soft(取指引异常→null 不拖垮 status)= 纯透明性叠加,不碰任何路由/成败。

不 commit(feat/0.1.104-multi-subsystem-batch)。
