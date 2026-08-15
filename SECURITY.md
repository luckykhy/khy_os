# 安全策略（Security Policy）

## 报告漏洞

**请不要用 GitHub Issue 报告安全问题。** Issue 是公开的，会在修复发布前暴露攻击面。

请走 GitHub 的私密披露通道：

> **[提交安全公告 →](https://github.com/kodehu03/khy-os/security/advisories/new)**

如果该通道不可用，请通过仓库主页 `README` 中列出的维护者联系方式私下联系，
邮件标题请以 `[SECURITY]` 开头。

### 请在报告中包含

1. 受影响的组件（CLI / backend / ai-backend / frontend / MoonBit 模块 / 内核）与文件路径。
2. 复现步骤，越确定越好。附最小复现脚本比描述更有用。
3. 影响面：能读到什么、写到什么、以什么身份执行、是否可远程触发。
4. 运行环境：操作系统、Node.js 与 Python 版本、安装渠道（pip / npm / 独立可执行文件 / 源码）。
5. 你希望的署名方式（或选择匿名）。

### 我们的响应

| 阶段 | 目标时间 |
| --- | --- |
| 确认收到 | 3 个工作日内 |
| 初步评估（是否成立、严重级别） | 10 个工作日内 |
| 修复与发布 | 视严重级别，高危优先，并在过程中同步进展 |

修复发布后会在 [`CHANGELOG.md`](CHANGELOG.md) 中记录，并在公告中致谢报告者（除非你选择匿名）。

**请在修复发布前不要公开披露。** 如果超过约定时间没有得到回应，欢迎再次催促；
我们不会以「还在处理中」为理由无限期拖延。

---

## 支持范围

安全修复只提供给**当前发布的次版本线**。项目仍在快速迭代，不维护历史分支的长期支持。
当前版本以根目录 [`CHANGELOG.md`](CHANGELOG.md) 顶部条目与 `pyproject.toml` 的
`[project].version` 为准（两者由发布门禁强制一致）。

运行时支持下限（以配置文件为真源，不在本文档中重复写死具体号）：

| 运行时 | 下限声明位置 |
| --- | --- |
| Node.js | `services/backend/package.json` 的 `engines.node` |
| Python | `pyproject.toml` 的 `requires-python` |

低于下限的环境不在安全支持范围内。

---

## 在范围内的问题

- 认证 / 授权绕过，会话与凭据处理缺陷（含 WebAuthn、JWT、密码重置路径）。
- 命令注入、路径穿越、任意文件读写、SSRF。
- 通过 AI 网关或工具调用链达成的越权执行（例如提示词注入导致的工具滥用、
  沙箱逃逸、把用户数据外发到第三方端点）。
- 凭据泄漏：日志、错误信息、遥测、打包产物中带出 API key 或令牌。
- 供应链问题：发布产物被污染、依赖投毒、构建脚本被劫持。
- 本地权限提升：守护进程、代理服务、安装脚本、可执行文件打包路径中的缺陷。

## 不在范围内的问题

- 需要攻击者已取得目标机器管理员权限才能实施的攻击。
- 用户自行配置导致的问题（例如把服务绑定到 `0.0.0.0` 并暴露到公网、
  在配置文件里明文写第三方 API key 后自行分享）。
- 第三方模型服务商侧的漏洞 —— 请报告给对应服务商；但**由本项目错误使用其 API
  而导致的问题在范围内**。
- 缺少某项加固措施而无法给出实际影响路径的报告（例如仅指出「未启用某个 HTTP 头」）。
  这类建议欢迎作为普通 Issue 提出。
- 自动化扫描器的原始输出。请先确认可复现再提交。

---

## 项目侧的安全措施

| 措施 | 位置 |
| --- | --- |
| 静态代码扫描（CodeQL） | `.github/workflows/codeql-analysis.yml`，结果在仓库 Security 页签 |
| 依赖更新 | `.github/dependabot.yml`（分组提交，`chore(deps)` 前缀） |
| 凭据文件门禁 | `pr-gate.yml` 会阻断把 `.env*` / `*.pem` / `*.key` / `credentials.json` / `secrets.{yml,yaml,json}` 带进改动集的 PR |
| 发布产物签名与溯源 | `dual-channel-release.yml`、`docker.yml`（sigstore 无密钥签名、SBOM、build provenance attestation） |
| 分支保护 | `.github/rulesets/`（ruleset-as-code） |

---

## 许可提示

本项目使用 **source-available**（源码可见）许可，而非 OSI 认可的开源许可
（见 `package.json` 的 `"license": "LicenseRef-Source-Available"`）。
「能看到源码」不等于「可自由分发或商用」。安全研究用途的复现与分析不受影响，
但请在使用衍生代码前确认许可条款。
