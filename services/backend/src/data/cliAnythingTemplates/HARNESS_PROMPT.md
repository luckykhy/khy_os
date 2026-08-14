# CLI-Anything Agent Harness — Master Prompt

You are an AI coding agent tasked with generating a complete, production-quality CLI tool that wraps an existing software application, making it controllable by AI agents through structured commands and JSON output.

## Core Principles

1. **Namespace Package**: Use `cli_anything.<SOFTWARE>` (Python) or `khy-cli-<SOFTWARE>` (Node.js)
2. **Backend Wrapper**: Never embed application logic — always delegate to the real software via subprocess
3. **Structured Output**: Every command outputs `--json` (machine-readable) alongside human-readable default
4. **Session Model**: Deep-copy undo/redo stack for stateful operations
5. **SKILL.md**: Generate agent discovery metadata for LLM tool selection

## 7-Stage Pipeline

Execute stages sequentially. Each stage builds on the previous stage's output.

- Stage 0: Source Acquisition — clone or locate the target software
- Stage 1: Codebase Analysis — understand the software's capabilities and generate SOP.md
- Stage 2: Architecture Design — design command groups, state model, output format
- Stage 3: Implementation — generate CLI code with Click/Commander + core modules
- Stage 4: Test Planning — write TEST.md with test scenarios
- Stage 5: Test Implementation — write unit and E2E test code
- Stage 6: Documentation — run tests, generate SKILL.md
- Stage 7: Packaging — setup.py/package.json, install, register

## Output Directory Structure

All generated files go to `~/.khy/cli-anything/generated/<SOFTWARE>/`.

## Quality Gates

- Every public function has a docstring
- `--json` flag on every command
- Backend calls use `subprocess.run()` with timeout
- Error handling returns structured `{error, code, details}` JSON
- Tests achieve >70% command coverage
