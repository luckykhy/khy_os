# Update Config — Configuration File Manager

## Purpose
Guide the user through updating project or global configuration files such as CLAUDE.md, settings.json, and hooks.json.

## Supported Configuration Files

### CLAUDE.md (Project Instructions)
- **Location**: Project root (`./CLAUDE.md`) or user home (`~/.claude/CLAUDE.md`)
- **Purpose**: Persistent instructions that are loaded into every conversation
- **Format**: Markdown with clear sections and bullet points
- **Common updates**: Coding conventions, project architecture notes, tool preferences

### settings.json (Claude Code Settings)
- **Location**: `~/.claude/settings.json` (global) or `.claude/settings.json` (project)
- **Purpose**: Configure Claude Code behavior, permissions, and MCP servers
- **Key fields**:
  - `permissions`: Allowed and denied tool patterns
  - `env`: Environment variables
  - `mcpServers`: MCP server configurations

### hooks.json (Automation Hooks)
- **Location**: `.claude/hooks.json`
- **Purpose**: Define automated actions triggered by events
- **Events**: `PreToolUse`, `PostToolUse`, `Notification`, `Stop`
- **Format**: Array of hook objects with `event`, `pattern`, and `command`

## Workflow

1. **Identify**: Ask what the user wants to configure (or infer from context).
2. **Read Current**: Read the existing config file to understand current state.
3. **Propose Change**: Show the specific edit that will be made.
4. **Apply**: After user confirmation, apply the change using Edit tool.
5. **Verify**: Read the file back to confirm the change was applied correctly.

## Guidelines
- Always read the file before modifying it to avoid overwriting existing settings.
- Use Edit tool for targeted changes, not Write tool for full rewrites.
- Validate JSON syntax before writing settings.json or hooks.json.
- Warn the user if a change might affect security (e.g., broadening permissions).
- Back up the original content in the conversation in case rollback is needed.
