# Stage 6: Documentation & SKILL.md

## Objective
Run tests, update TEST.md with results, and generate SKILL.md for agent discovery.

## Inputs
- Test code from Stage 5
- Source code from Stage 3

## Steps

1. **Run tests**:
   - Python: `pytest tests/ -v --tb=short`
   - Node.js: `node --test tests/` or `npx jest tests/`
   - Record pass/fail counts and any failures

2. **Update TEST.md (Part 2)** — append test results:
   ```markdown
   ## Test Results
   - Total: N tests
   - Passed: N
   - Failed: N
   - Skipped: N

   ### Failures
   - test_xxx: <failure reason>
   ```

3. **Generate SKILL.md**:
   ```markdown
   ---
   name: cli-anything-<SOFTWARE>
   description: <one-line description for LLM tool selection>
   version: 1.0.0
   tags: [<SOFTWARE>, cli-anything, agent-tool]
   entry_point: cli-anything-<SOFTWARE>
   ---

   # <SOFTWARE> Agent Tool

   You have access to `cli-anything-<SOFTWARE>`, a command-line tool for AI agent control of <SOFTWARE>.

   ## Available Commands

   | Command | Description | Example |
   |---------|-------------|---------|
   | `project create` | Create new project | `cli-anything-<SOFTWARE> project create --name myproject` |
   | ... | ... | ... |

   ## Usage Patterns

   ### Basic Workflow
   ```bash
   cli-anything-<SOFTWARE> project create --name demo --json
   cli-anything-<SOFTWARE> <domain> <action> --json
   cli-anything-<SOFTWARE> export render --output result.png --json
   ```

   ## Error Handling
   If a command fails, check `--json` output for `{"status": "error", "error": "..."}`.
   ```

## Output
- Updated `TEST.md` (Part 2)
- `skills/SKILL.md`
