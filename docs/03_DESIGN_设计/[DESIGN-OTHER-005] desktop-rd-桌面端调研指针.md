# DESIGN-OTHER-005 · desktop-rd 调研指针

> **调研档案位置**：`extensions/scripts/khy-desktop-rd/`
> **调研日期**：2026-08-31
> **状态**：调研完成，等待用户/团队路线评审
> **目的**：给 khy-os 加独立桌面端时，参考外部开源项目，避免从零设计

---

## 一、为什么需要这条指针

`docs/03_DESIGN_设计/` 严格遵循"架构与设计规范"类目边界，**不收实现报告（归 `04_IMPL_实现/`）、不收调研档案（应归 `extensions/scripts/` 下的合规拓展）**。

但调研档案是设计选型的"前置输入"——如果新设计师/AI 助手接手桌面端选型时不知道档案在哪，可能走错路。所以本文件作为**唯一的索引指针**存在，从设计类目侧引用 `extensions/scripts/khy-desktop-rd/`。

## 二、调研档案目录

```
extensions/scripts/khy-desktop-rd/
├── README.md                  ← 主索引（必读）
├── khy.extension.json         ← kind: asset（只读参考拓展）
├── openflux/                  ← ① Tauri v2 + Node Sidecar（与 khy-os 同构）
├── goose/                     ← ② Electron 43 + React 19（工程化最成熟）
├── chatml/                    ← ③ Tauri 2 + Go Backend（多层架构清晰）
├── one-api/                   ← ④ khy-os 视觉风格的源头
└── cmdk/                      ← 附 Cmd+K 组件（ZCode 风格关键）
```

详细目录说明、文件清单、推荐路线、IPC 体系、khy-os 对照表均在 `extensions/scripts/khy-desktop-rd/README.md`。

## 四、当前结论摘要

- **桌面端目标视觉**：参考 `D:\Portable\4-output\ZCode-UI\running\` 14 张截图（深色 IDE + 暖橙 #f76b1c）
- **候选技术路线**：A (Electron + 内嵌 Vue + 内嵌 Node) / B (Tauri 2 + Rust 命令层) / C (MVP 先出)
- **初步倾向**：路线 A（参考 goose 的 IPC 体系 + OpenFlux 的 Sidecar 模式）
- **下一步**：用户/团队评审后，进入实施阶段（预计新建 `apps/desktop/`）

## 五、引用规范

后续任何"桌面端相关"的实现报告（`04_IMPL_实现/[IMPL-RPT-*]`）或设计文档（`03_DESIGN_设计/[DESIGN-ARCH-*]`）应在开头引用本指针：

```markdown
> 调研档案：`extensions/scripts/khy-desktop-rd/`
> 调研指针：`docs/03_DESIGN_设计/[DESIGN-OTHER-005]`
```

## 六、变更日志

- 2026-08-31：初版建立，调研 4 个核心项目 + 1 个 UI 组件范式