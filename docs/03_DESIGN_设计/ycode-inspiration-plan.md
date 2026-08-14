# Y-code (星瑶) → Khyos: Implementation Plan

## Executive Summary

Y-code (https://gitee.com/feng-chenhao/xingyao-y-code.git) is a terminal AI coding assistant
that shares the same "Claude Code-aligned" philosophy as Khyos but with some mature patterns
Khyos can benefit from. Khyos already has a richer platform (web UI, multi-tenant, IDE bridges,
workflow editor, marketplace), but lacks some refined UX and architecture patterns Y-code has
pioneered.

## Gap Analysis

### Features Y-code Has That Khyos Should Adopt

| # | Feature | Y-code Pattern | Khyos Gap | Priority |
|---|---------|---------------|-----------|----------|
| 1 | **Stable + Dynamic Prompt Architecture** | System prompt split into stable prefix (cross-turn cached) + dynamic context (per-turn time/plan/model). Stable prefix padded to 2048-token boundaries for DeepSeep cache hit. | Khyos builds system prompt every turn from scratch with `makeSystemPrompt()`. No explicit stable/dynamic split for cache optimization. | **HIGH** |
| 2 | **ToolSpec metadata-driven permissions** | Frozen dataclass with `requires_permission`, `parallel_safe`, `cancellable`, `mutates_files`, `activity_description` flags driving automatic permission checks. | Khyos tools have permission checks but they're implicit/hardcoded in execution paths. | **HIGH** |
| 3 | **Source text compression** | Strip trailing whitespace + merge consecutive blank lines before sending file content to LLM (saves 10-20% tokens, preserves semantics). | No pre-send source compression in Khyos. | **HIGH** |
| 4 | **Tool call argument resilience** | 3-level JSON repair + schema-based argument filtering removes hallucinated params. | Unknown if Khyos handles LLM hallucinated tool arguments. | **MEDIUM** |
| 5 | **Long-term memory (KAIROS)** | Daily logs + MEMORY.md index + `build_memory_system_section()` injected into stable prompt + dream consolidation background thread. | Khyos has memoryEngine and memdir but no daily log pattern or auto-consolidation. | **HIGH** |
| 6 | **Session undo + checkpoint** | `/undo` rolls back last file modification + wipes model memory. `/checkpoint restore` rolls back entire turn. | Khyos has session persistence but no undo/checkpoint. | **MEDIUM** |
| 7 | **Session share/export** | `/share` exports conversation as MD/HTML/JSON. | Not found in Khyos. | **LOW** |
| 8 | **Git worktree management** | `/worktree` manages multi-branch parallel workspaces. | Khyos has "Projects" but not git worktree isolation. | **MEDIUM** |

### Features Khyos Has That Y-code Lacks (no action needed)

- Web-based multi-user platform (Y-code is single-user TUI)
- Multi-tenant architecture with PostgreSQL
- Visual workflow editor (drag-and-drop Vue Flow)
- 30+ IDE adapters (Cursor, Trae, Kiro, Warp, etc.)
- LLM Gateway with circuit breaking + rate limiting
- Plugin marketplace (Coze-compatible OpenAPI)
- IDE bridge system for remote development
- 11 built-in agents with Claude Code alignment

## Implementation Progress

### Phase 1: Core Architecture ✅ DONE

| # | Feature | Status | Files |
|---|---------|--------|-------|
| 1 | **Source text compression** | ✅ Done | `services/backend/src/utils/sourceTextCompressor.js` |
| 2 | **Tool result compression** | ✅ Done | `services/backend/src/services/toolResultCompressor.js` |
| 3 | **Long-term memory (KAIROS)** | ✅ Done | `services/backend/src/services/memoryKairos.js` |
| 4 | **Stable + Dynamic prompt assembly** | ✅ Done | `services/backend/src/services/promptAssemblyService.js` |
| 5 | **FileReadTool integrate compress** | ✅ Done | `tools/FileReadTool/index.js` (+compress param) |
| 6 | **Runtime export integration** | ✅ Done | `services/backend/src/services/khyUpgradeRuntime.js` |
| 7 | **Wire toolResultCompressor into contextRouter** | ✅ Done | `preCompressToolResults()` added before truncation in `contextRouter.js` + `_toolResultNormalizer.js` |
| 8 | **Wire memoryKairos into aiChatCore** | ✅ Done | Daily log + memory tag extraction appended after each turn (fire-and-forget) |
| 9 | **Wire sourceTextCompressor into more tools** | ✅ Done | Added to `_toolResultNormalizer.js` `mapToolResultToModelBlock()` — covers ALL tools globally |
| 10 | **Wiring toolResultCompressor into additional tools** | ✅ Done | Applied in `_toolResultNormalizer.js` + `contextRouter.js` pre-send pipeline |
| 11 | **Wire memoryKairos into existing memory section** | ✅ Done | Appended to system prompt via `buildMemorySystemSection()` in `promptAssemblyService.js` |

### Phase 2: Remaining (not yet implemented)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 7 | **Session undo/checkpoint** | Pending | Needs DB schema + CLI handlers |
| 8 | **Session share/export** | Pending | MD/HTML/JSON export of conversations |
| 9 | **ToolSpec metadata refactor** | Pending | Low priority — existing tools work |
| 10 | **Git worktree management** | Pending | Low priority — Khyos has Projects |

## Phase 2 Remaining (not yet implemented)

| # | Feature | Status | Notes |
|---|---------|--------|-------|
| 7 | **Session undo/checkpoint** | Pending | Needs DB schema + CLI handlers |
| 8 | **Session share/export** | Pending | MD/HTML/JSON export of conversations |
| 9 | **ToolSpec metadata refactor** | Pending | Low priority — existing tools work |
| 10 | **Git worktree management** | Pending | Low priority — Khyos has Projects |

## Phase 3: Output Quality & Formatting (new patterns from deep source analysis)

| # | Feature | Y-code Source | Khyos Gap | Priority |
|---|---------|--------------|-----------|----------|
| 11 | **Tool result sanitization** | `tool_presenter.py` — `sanitize_tool_display_text()` strips ANSI/control chars, cookies, secrets, API keys from tool results before display | Khyos passes raw tool results directly to frontend without sanitization | **MEDIUM** |
| 12 | **Tool progress aggregation** | `tool_progress.py` — `ToolProgressAggregator` batches adjacent read/search tool calls into single "已读取3个文件 · 0.8s" lines, detects parallel execution | Khyos shows each tool call as separate line — noisy when LLM issues parallel reads | **MEDIUM** |
| 13 | **Session memory compression** | `memory_compressor.py` — LLM-based session history compression: retain recent N messages, summarize older ones via secondary (cheap) model, optimistic concurrency guard | Khyos has memoryKairos but not session-level LLM compression of conversation history | **HIGH** |
| 14 | **Turn event standardization** | `turn_renderer.py` — `TurnRenderer` processes structured turn events (thinking_delta, tool_started, tool_finished, diff_ready, plan_updated), sanitizes protocol text, splits text at code-block/thinking-tag boundaries | Khyos renders tool results as raw JSON — no structured event pipeline for progressive display | **MEDIUM** |
| 15 | **Frontend markdown theme system** | `themes.py` — 9 curated terminal color themes (cyan, matrix, nord, cyberpunk, dracula, lava, sunset, amber, white) | Khyos has light/dark toggle but no theme diversity or terminal-style color system | **LOW** |

### Pattern Deep-Dives

#### 11. Tool Result Sanitization (`tool_presenter.py`)
```python
# 5-layer sanitization pipeline:
# 1. Strip ANSI escape codes
# 2. Mask cookie headers: "cookie: sk-abc..." → "cookie: ***"
# 3. Strip control characters (0x00-0x1f except \n)
# 4. Mask named secrets: api_key=xxx → api_key=***
# 5. Mask Bearer tokens and OpenAI keys (sk-...)
# 6. Collapse whitespace + truncate to limit
```
**Khyos adoption**: Server-side `sanitizeToolDisplayText()` that sanitizes ALL tool results before sending to frontend.

#### 12. Tool Progress Aggregation (`tool_progress.py`)
```python
# Key insight: adjacent read_file/search_code calls → single summary line
# "已读取 3 个文件 · 1.2s" instead of 3 separate lines
# Parallel reads → "正在并行读取 3 个文件"
# Mutation tools with diff → "+5 / -2 行" inline
```
**Khyos adoption**: Backend aggregates tool results per-turn, returns `toolProgress` block with batch summary.

#### 13. Session Memory Compression (`memory_compressor.py`)
```python
# Flow:
# 1. Read all messages, retain last N (default 8)
# 2. Pack older messages → call LLM (prefer cheap secondary model) for summary
# 3. Safety: tool_call groups must not be split (orphan check)
# 4. Concurrency: reentrant lock per session + optimistic boundary check
# 5. Summary prompt: decisions, files, bugs, current goal — strictly word-limited
```
**Khyos adoption**: `memoryCompressor.js` for session-level LLM compression of conversation history.

#### 14. Turn Event Standardizer (`turn_renderer.py`)
```python
# Structured event types:
# thinking_delta → consumed, not rendered
# thinking_finished → flush via thinking_stream buffer
# tool_started/tool_requested → track in progress aggregator
# tool_finished → format via tool_presenter
# diff_ready → parse diff stats, emit "+5/-2" summary
# plan_updated → render plan status with ANSI colors
# Error handling → dedup, suppress duplicates
```
**Khyos adoption**: Turn event types for structured streaming of tool execution results.

#### 15. Theme System (`themes.py`)
```python
# 9 themes, each with 8 color slots:
# border, label, status_main, status_text, status_sep,
# text_input, menu_current, menu_current_meta
# Pure CSS hex values — easily portable to web
```
**Khyos adoption**: Frontend theme presets as CSS custom properties.

### Implementation Log

**2026-08-08**: Implemented 4 new services + 2 integration points:
1. `sourceTextCompressor.js` — strips trailing whitespace + merges blank lines (saves 10-20% tokens)
2. `toolResultCompressor.js` — pre-send truncation of tool results (head+tail for large results)
3. `memoryKairos.js` — daily logs + MEMORY.md index + dream consolidation via LLM
4. `promptAssemblyService.js` — stable prefix (cached across turns) + dynamic context (per-turn)
5. `FileReadTool/index.js` — added `compress` parameter to Read tool
6. `khyUpgradeRuntime.js` — exported prompt assembly functions

**2026-08-10**: Wired Phase 3 services into production pipelines + additional patterns:
7. `toolResultSanitizer.js` — 6-layer sanitization pipeline (ANSI/cookie/secrets/Bearer/OpenAI key/whitespace)
8. `toolProgressAggregator.js` — batches adjacent read/search calls into summary lines, parallel detection
9. `memoryCompressor.js` — LLM-based session compression with reentrant guard + tool-call pair safety
10. `turnEventStandardizer.js` — 8 structured event types for progressive streaming display
11. Wired `triggerCycleBoundary` into aiChatCore.js tool loop — auto-compress at 192K tokens (env `KHY_CYCLE_THRESHOLD_TOKENS`)
12. Wired `sourceTextCompressor` into `_toolResultNormalizer.js` — lossless whitespace compression before truncation
13. Wired plan retry protection — step status advances to 'blocked' after 2+ failures, forcing root-cause analysis
14. Wired dream consolidation into aiChatCore.js — fires every N turns (env `KHY_DREAM_CONSOLIDATE_INTERVAL`, default 10)

**2026-08-10 (phase 2)**: High-value patterns from deep source analysis:
15. Tool argument hallucination filter — `toolCalling.js` filters LLM-fabricated params by schema (only keeps schema-declared keys + internal keys like `cancel_event`). Matches Y-code `tool_registry.py:57-61`.
16. Failed subagent self-healing injection — already wired in `aiChatCore.js:2887` via `_buildStepRecoveryPrompt` + `aiGatewayGenerateHelpers.js:335`. When tools fail, model receives recovery guidance to retry with different approach.
17. Plan state machine guard — already satisfied architecturally: Khyos does NOT expose plan management tools to LLM (state managed by execution engine internally). Y-code's plan guard is unnecessary in Khyos's different architecture.
