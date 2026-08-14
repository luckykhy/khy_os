# Verify — Change Verification

## Purpose
Verify that recent changes work correctly by running all relevant tests, lint checks, and type checks.

## Workflow

1. **Detect Changes**: Run `git diff --name-only` and `git diff --cached --name-only` to identify recently changed files.
2. **Identify Relevant Checks**: Based on changed files, determine which checks to run:
   - **JavaScript/TypeScript**: `npm test`, `npx eslint`, `npx tsc --noEmit`
   - **Python**: `pytest`, `ruff check`, `mypy`
   - **Rust**: `cargo test`, `cargo clippy`
   - **Go**: `go test ./...`, `go vet ./...`
   - **General**: Any project-specific test scripts in `package.json` or `Makefile`.
3. **Run Checks**: Execute each check and capture output.
4. **Report Results**: Provide a clear summary:
   - Total checks run
   - Passed / Failed counts
   - For failures: file, line number, and error message
   - Suggested fixes for common issues

## Guidelines
- Always check for a project-level test configuration (package.json scripts, Makefile targets, CI config) before assuming default commands.
- Run the most targeted tests first (unit tests for changed files), then broader checks.
- If no test framework is detected, report that and suggest setting one up.
- Do not modify any code during verification — this is a read-only operation.
- If tests fail, provide actionable suggestions but do not auto-fix unless the user asks.
