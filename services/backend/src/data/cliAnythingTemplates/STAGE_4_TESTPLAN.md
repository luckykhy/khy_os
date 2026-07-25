# Stage 4: Test Planning

## Objective
Write a comprehensive test plan (TEST.md Part 1) covering all commands and edge cases.

## Inputs
- Source code from Stage 3
- `architecture.json` from Stage 2

## Steps

1. **List all commands** from the CLI entry point

2. **For each command, define test scenarios**:
   - Happy path: normal input, expected output
   - Edge case: empty input, large input, special characters
   - Error case: missing dependencies, invalid parameters, timeout
   - JSON mode: verify `--json` output matches schema

3. **Define integration tests**:
   - Full workflow: create → edit → export
   - Session: undo → redo → verify state
   - Backend: verify software is called with correct arguments

4. **Generate `TEST.md` (Part 1)**:
   ```markdown
   # Test Plan: cli-anything-<SOFTWARE>

   ## Unit Tests
   ### <command_group>.<command>
   - [ ] Test: <description> — Input: <input> — Expected: <output>

   ## Integration Tests
   ### Workflow: <workflow_name>
   - [ ] Step 1: ...
   - [ ] Step 2: ...

   ## Edge Cases
   - [ ] Software not installed
   - [ ] Permission denied
   - [ ] Timeout on long operations
   ```

## Output
- `TEST.md` — test plan document (Part 1)
