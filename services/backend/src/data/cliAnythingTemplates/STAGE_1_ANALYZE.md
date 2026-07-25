# Stage 1: Codebase Analysis

## Objective
Deeply understand the target software's capabilities, architecture, and workflows to produce a Standard Operating Procedure (SOP) document.

## Inputs
- `stage0_result.json` from Stage 0

## Steps

1. **Read core source files** — identify:
   - Main entry points and CLI commands
   - Core classes and functions
   - Configuration and state management
   - File format support (input/output)
   - External dependencies

2. **Read documentation** — scan README, docs/, man pages, `--help` output

3. **Identify key workflows** — what does a typical user do with this software?
   - Creation workflow (new project/document/scene)
   - Editing workflow (modify, transform, adjust)
   - Export workflow (render, compile, save)
   - Batch workflow (multiple files, automation)

4. **Map capabilities** — for each workflow, list:
   - Required parameters
   - Optional parameters with defaults
   - Output types and formats
   - Error conditions

5. **Generate `<SOFTWARE>.md`** (SOP document):
   ```markdown
   # <SOFTWARE> Analysis

   ## Overview
   <what the software does, primary use case>

   ## Key Capabilities
   <numbered list of what can be controlled>

   ## Workflows
   ### 1. <workflow name>
   - Steps: ...
   - Parameters: ...
   - Output: ...

   ## State Model
   <what state needs to be tracked between operations>

   ## Error Patterns
   <common failure modes and how to detect them>
   ```

## Output
- `<SOFTWARE>.md` — the SOP analysis document
