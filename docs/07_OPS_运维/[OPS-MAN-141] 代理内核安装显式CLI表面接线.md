# [OPS-MAN-141] 代理内核安装显式 CLI 表面接线（能力存在但未接线 → 补接线）

## 一句话
代理内核 mihomo 的 `install()` 能力此前**只有自动触发路径**（raw 节点 `start()` 时
`proxyCoreManager.js` 自动调用），**无任何显式/主动的用户表面**；离机（headless / pip 安装）
用户必须先配置并启动一个 raw 节点才能间接触发。本次给它接上 `khy proxy core install|status`
显式命令，补齐「能力存在但没接线」的缺口。

## 断桥判据（为什么这是真缺口）
- `proxyCoreInstaller.install()` 是一个**幂等、fail-soft、结构化返回**的成熟能力
  （已装→existing / PATH 采纳→adopted / 门关→disabled+guidance / 否则→官方 HTTPS 下载+SHA256 校验）。
- 唯一消费者是 `proxyCoreManager.js:243` 的 `start(node)` **自动安装**分支。
- 结论：能力完备，但**没有面向用户的主动入口**。无头/离机用户看不到、够不到 =「没接线」。

## 本次改动（全 additive · 门 `KHY_PROXY_CORE_INSTALL_CLI` default-on · 门关字节回退到 proxy help）
| 文件 | 改动 |
| --- | --- |
| `services/backend/src/cli/handlers/proxyCoreInstallHandler.js` | **新叶**：纯格式化器（`formatDownloadHint` / `formatCoreInstallResult` / `formatCoreStatus`）+ fail-soft `runCore`。失败**始终**追加「你可以手动下载:」+ 精确 URL + 落盘路径。 |
| `services/backend/src/services/flagRegistry.js` | 登记 `KHY_PROXY_CORE_INSTALL_CLI`（default-on）。 |
| `services/backend/src/cli/handlers/proxy.js` | `handleProxyCore(action)` 门控包装（门关→`handleProxyHelp` 字节回退）+ 导出 + help 行。 |
| `services/backend/src/cli/router.js` | `subCommand === 'core'` → `proxy.handleProxyCore(...)` 分派。 |
| `services/backend/tests/cli/proxyCoreInstallHandler.test.js` | 20 例：格式化器全变体 + fake installer 驱动 runCore + 源级 wiring（readFileSync+regex）。 |

## 用户表面
```
khy proxy core status     # 查看内核是否安装 + 未装时去哪下载（精确 URL + 落盘路径）
khy proxy core install    # 幂等安装：已装即返回 / PATH 采纳 / 门控官方 HTTPS 下载 + SHA256
```

## 验收（本次全绿）
- `node --test .../proxyCoreInstallHandler.test.js` → 20/20 pass。
- LIVE：真 installer 经 runCore `status`（零网络）→ 精确输出下载 URL + `~/.khyquant/bin/mihomo`。
- 门关：`KHY_PROXY_CORE_INSTALL_CLI=0` → `handleProxyCore` 回退到 proxy help（字节回退）。
- 回归：`proxyCoreInstaller` + `proxyCoreManager` 既有套件 38/38 pass。
- 守卫：change-safety / agent-rules / leaf-contract / flag-registry / maintainer:check 全 exit0。
- god-file：新叶 138 行；`proxy.js` 2460；`router.js` 2495（均 < 2500）。

## 教训
- 「能力存在但没接线」的判据 = 能力完备且 fail-soft，但**唯一消费者是内部自动路径**，无用户主动入口。
- 离机/无头场景优先补 **CLI 表面**（可离线验证、契合 pip 安装现实），而非 Web 按钮。
- 门关必须**字节回退**到既有行为（这里回退到 proxy help）。
