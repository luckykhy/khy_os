/**
 * `@khy/ui-shared/board` 的 Node 安全入口 —— **只导出纯 JS 模型**。
 *
 * ⚠ 这里刻意**不**再导出 `TaskBoard.vue` / `TaskCard.vue`：
 *   一旦本文件 import 了 `.vue`，任何 Node 侧消费者（`node --test`、SSR、
 *   构建期脚本）只要 import 这个子路径就会因无法解析 SFC 而崩。
 *   需要组件的前端请直接引 `@khy/ui-shared/board/TaskBoard.vue`（由 Vite 的
 *   `@vitejs/plugin-vue` 处理）。
 */
export {
  ACTION_LABELS,
  ACTION_ORDER,
  BREAKPOINTS,
  LANE_ORDER,
  LANE_TITLES,
  STATUS_TONE,
  SWIMLANE_KIND_LABELS,
  actionLabel,
  cardsAt,
  cardsOfSwimlane,
  emptyMessage,
  formatRelative,
  isActionable,
  laneTabs,
  normalizeBoard,
  normalizeCard,
  normalizeLane,
  normalizeSwimlane,
  resolveBreakpoint,
  statusTone,
  summarize,
  visibleSwimlanes,
} from './model.js';
