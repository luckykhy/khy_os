---
name: 文件上传规范
id: UPLOAD-001
domain: SECURITY
nature: 约束
scope: "services/backend/src/routes/uploads/**, services/backend/src/services/**"
priority: P0
trigger: "新增或修改上传端点、上传存储、上传读取逻辑时"
constraint: "五原则：不信任客户端（服务端验证）、最小权限（不可执行、不可访问其他目录）、可追溯（唯一 ID + 完整元数据）、可清理（生命周期自动清理）、类型安全（严格内容类型检查防伪装）。ID 格式 <32-hex-chars>.<extension>，32 字符十六进制，由 crypto.randomBytes(16).toString('hex') 生成，ID_RE = /^[a-f0-9]{32}$/，拒绝路径遍历。大小上限：图片 50MB、视频 500MB、音频 100MB、文档 50MB、代码 5MB、文本 10MB、压缩包 200MB、通用 100MB，各由 KHY_AI_UPLOAD_*_MAX_BYTES 覆盖。MIME 类型必须以魔数检测为准，不接受客户端声明。生产环境必须启用病毒扫描，检测到病毒立即删除，扫描超时视为通过。禁止：上传 .exe/.bat/.sh/.dll 等可执行文件、使用原始文件名存储、上传目录设为可执行、信任客户端 MIME 类型、返回服务器绝对路径。单文件 100MB、单请求 10 个文件、单请求总 500MB。"
grants: "无新增权力：仅约束具体做法，不授予任何新权限。"
benefit: 上传链路的每一环（ID/大小/MIME/执行权限/病毒）都有可检阈值，路径遍历与伪装攻击无入口。
exception: 扫描超时视为通过（不阻塞上传流程）。
version: "1.0.0 (2026-09-16)"
status: active
ssot: "docs/_规范/[DESIGN-UPLOAD-001] 文件上传规范.md"
formerly: 无
owner: security-team
---

# [UPLOAD-001] 文件上传规范

<!-- RULES-REGISTRY: UPLOAD-001 -->

> **规则卡** · 格式依据 [MGMT-STD-008] §1（frontmatter 14 字段 + 六小节）。
>
> **字段真源**是 `docs/_规范/RULES-REGISTRY.json`（GOV-TOOL-006 校验），
> 本文件由 `node scripts/docs/gen-rules-cards.js` 生成，**禁止手改**（同 [MGMT-STD-007] R6 对 .html 孪生件的约束）。
> 正文原文在 `ssot` 指向的位置：docs/_规范/[DESIGN-UPLOAD-001] 文件上传规范.md。

## 约束

五原则：不信任客户端（服务端验证）、最小权限（不可执行、不可访问其他目录）、可追溯（唯一 ID + 完整元数据）、可清理（生命周期自动清理）、类型安全（严格内容类型检查防伪装）。ID 格式 <32-hex-chars>.<extension>，32 字符十六进制，由 crypto.randomBytes(16).toString('hex') 生成，ID_RE = /^[a-f0-9]{32}$/，拒绝路径遍历。大小上限：图片 50MB、视频 500MB、音频 100MB、文档 50MB、代码 5MB、文本 10MB、压缩包 200MB、通用 100MB，各由 KHY_AI_UPLOAD_*_MAX_BYTES 覆盖。MIME 类型必须以魔数检测为准，不接受客户端声明。生产环境必须启用病毒扫描，检测到病毒立即删除，扫描超时视为通过。禁止：上传 .exe/.bat/.sh/.dll 等可执行文件、使用原始文件名存储、上传目录设为可执行、信任客户端 MIME 类型、返回服务器绝对路径。单文件 100MB、单请求 10 个文件、单请求总 500MB。

## 授予权力

无新增权力：仅约束具体做法，不授予任何新权限。

## 提供福利

上传链路的每一环（ID/大小/MIME/执行权限/病毒）都有可检阈值，路径遍历与伪装攻击无入口。

## 反例

见 `ssot` 指向的真源原文；本卡不复制反例，以免与真源漂移。

## 校验方式

人工评审（该规则暂无机械守卫）

## 例外

扫描超时视为通过（不阻塞上传流程）。

## 版本记录

- 1.0.0 (2026-09-16) 初版 / 迁移自 无
