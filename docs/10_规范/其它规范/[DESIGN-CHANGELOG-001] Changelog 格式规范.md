# [DESIGN-CHANGELOG-001] Changelog 格式规范

> **用途**：定义 khy-os 项目的 CHANGELOG 格式标准，基于 [Keep a Changelog](https://keepachangelog.com/)。
> 当前 `CHANGELOG.md` 存在但格式不统一。

---

## 1. 格式

```
# Changelog

## [Unreleased]

## [1.2.0] - 2026-09-10

### Added
- New feature description

### Changed
- Changed description

### Deprecated
- Deprecated feature (will be removed in 2.0.0)

### Removed
- Removed feature

### Fixed
- Bug fix description

### Security
- Security fix description
```

---

## 2. 版本分类

| 分类 | 说明 | 使用场景 |
|------|------|---------|
| `Added` | 新功能 | 新 API、新 CLI 命令、新组件 |
| `Changed` | 变更 | 功能修改、配置变更 |
| `Deprecated` | 即将移除 | 标记为废弃，指定移除版本 |
| `Removed` | 已移除 | 废弃功能正式删除 |
| `Fixed` | 修复 | Bug 修复 |
| `Security` | 安全 | 安全漏洞修复 |

---

## 3. 书写规则

| 规则 | 说明 | 示例 |
|------|------|------|
| 版本号链接 | 链接到 Git tag | `[1.2.0]` |
| 日期格式 | ISO 8601 | `2026-09-10` |
| 变更描述 | 祈使句、简洁 | `Add refresh token rotation` |
| 关联 Issue | 括号引用 | `Fix login crash (#198)` |
| 分组 | 按分类分组 | Added / Changed / Fixed |
| 不重复 | 一个变更只出现一次 | 不在多个分类重复 |

---

## 4. 自动化

```json
// package.json
{
  "scripts": {
    "changelog": "conventional-changelog -p angular -i CHANGELOG.md -s"
  }
}
```

配合 `commitlint` + `conventional-changelog` 自动生成。

---

## 5. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义 Changelog 格式规范 |

---

*本规范由 khy-os 平台团队维护*
