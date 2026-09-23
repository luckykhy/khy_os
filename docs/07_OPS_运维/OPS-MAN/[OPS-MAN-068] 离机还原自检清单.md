# [OPS-MAN-068] 离机还原自检清单

> 本文件由 `scripts/restore-check.js --gen-doc` 确定性生成，请勿手改；
> 规则改在 `scripts/lib/restoreReadiness.js` 的 `_RULES`，再重新生成。

## 这份清单是干什么的

khyos 只有两条离机渠道，二者缺一不可、互为冗余：

- **pip**：`pip install khy-os`
- **npm**：`npm install -g @khy-os/khy-os`

在**任意新机器**上装好后，跑一句自检就知道能不能完整还原：

```bash
node scripts/restore-check.js      # 或 npm run restore-check
```

它会探测本机事实（Node/npm/tar/bundled/版本同步/目录可写……），
给出「就绪 / 未就绪」+ 每条拦路项与提醒的**照抄即用修法**。

## 一句话真相：包里有什么、没有什么

- 两条渠道的包都自带 **bundled 后端源码 + 加密全量源码快照**（`khy restore` 可解）。
- 两条渠道都**不打包 `node_modules`**：后端 44 个依赖在**首次运行时联网** `npm install` 补齐。
- Node.js 运行时**不打包**：缺失时 khy 首启自动下载便携版（`KHY_AUTO_INSTALL_NODE` 默认开）。
- 结论：**装好包 + 首次联网跑一次 = 完整还原**。想离线还原，须在有网机器先跑通一次再整目录拷走。

## 自检会检查这些项

| 项 | 级别 | 症状 | 修法 |
|----|------|------|------|
| `node-missing` | 拦路 | Node.js 不可用或版本过低（khyos 后端是 Node 运行时，没有它无法启动） | khy 会在首启自动下载便携版 Node（KHY_AUTO_INSTALL_NODE 默认开）；若被禁用或下载失败，请手动装 Node ≥ 20 后重跑 khy。 |
| `npm-missing` | 拦路 | npm 不可用（首启需 npm 把后端 44 个依赖 hydrate 出来） | 安装随 Node 附带的 npm（装 Node ≥ 20 通常自带）；装好后重跑 khy，bootstrap 会自动补齐 node_modules。 |
| `bundle-missing` | 拦路 | bundled 后端源码缺失（包不完整，还原无从谈起） | 重新安装官方包：pip 通道 `pip install --force-reinstall khy-os`，或 npm 通道 `npm install -g @khy-os/khy-os`；两条渠道的包都自带 bundled 源码。 |
| `offline-no-modules` | 拦路 | 离线且后端依赖未 hydrate（两条渠道都不打包 node_modules，首启须联网补齐） | 接入能访问 npm registry 的网络后重跑 khy 完成首启 hydrate；确需离线，请在有网机器上先跑通一次，再把整个已 hydrate 的 khyos 目录整体拷到离线机。 |
| `versions-drift` | 拦路 | pip / npm / backend 版本不一致（双渠道漂移会导致还原到半新半旧的裂脑状态） | 统一到同一版本：`khy update` 会按当前渠道同步；或重装官方包让三处版本归一（红线要求 pip khy-os 与 npm @khy-os/khy-os 版本必须相等）。 |
| `tar-missing` | 提醒 | 系统 tar 不可用（khy restore 解包源码快照依赖它，缺它则整份工作树快照无法展开） | 装系统 tar：Linux/macOS 自带；Windows 10 1803+ 自带，老版本 Windows 请装 tar 或用 7-Zip 手动解 _source 快照。 |
| `modules-not-hydrated` | 提醒 | 后端依赖尚未 hydrate（首次运行会联网 npm install，属正常，耗时几分钟） | 首启会自动补齐；想提前跑通就先执行一次 khy（或 khy doctor），等 node_modules 落好即算还原完成。 |
| `install-readonly` | 提醒 | 安装目录不可写（bootstrap 要往包内写 node_modules / .env，只读会让首启失败） | 改用用户级安装：`pip install --user khy-os`，或把 npm 全局前缀指向可写目录后重装。 |
| `single-channel` | 提醒 | 仅装了一条渠道（pip 与 npm 是仅有的两条离机渠道，留一条备用更稳） | 可选：另一条渠道也装上做冗余——pip 用户加 `npm install -g @khy-os/khy-os`，npm 用户加 `pip install khy-os`；两者共存由 khy update 渠道感知同步。 |

## 人工还原步骤（照着做）

1. 装任一渠道的包（两条都装更稳）：
   ```bash
   pip install khy-os
   npm install -g @khy-os/khy-os
   ```
2. 跑自检，按拦路项逐条修：
   ```bash
   node scripts/restore-check.js
   ```
3. 首次运行 khy（会联网 hydrate 后端依赖，耗时几分钟，属正常）：
   ```bash
   khy doctor
   ```
4. 需要还原完整工作树快照时：
   ```bash
   khy restore
   ```

## 红线（继承项目章程）

- 真 key/token 永不进包、不落盘；占位 key 一眼假。
- pip `khy-os` 与 npm `@khy-os/khy-os` 版本号必须一致（自检的 `versions-drift` 项守此线）。
- 本清单不教任何 commit/push/rm/curl/publish 类危险动作。

