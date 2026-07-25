# Git Commit Skill

Create a well-formed git commit by analyzing staged and unstaged changes.

## Procedure

1. **Inspect repository state** (run in parallel):
   - `git status` to see all untracked and modified files.
   - `git diff --cached` and `git diff` to see staged and unstaged changes.
   - `git log --oneline -10` to understand the commit message style of the repository.

2. **Analyze the changes**:
   - Classify the change type: new feature, enhancement, bug fix, refactoring, test, docs, chore.
   - Identify files that should NOT be committed (secrets, `.env`, credentials, large binaries).
   - If no changes exist, inform the user and do not create an empty commit.

3. **Stage relevant files**:
   - Prefer adding specific files by name rather than `git add -A` or `git add .`.
   - Warn the user if any file appears to contain secrets.

4. **Draft the commit message**:
   - Follow the repository's existing commit message convention (conventional commits, imperative mood, etc.).
   - Keep the subject line under 72 characters.
   - Summarize the "why" rather than the "what".
   - Add a body if the change is non-trivial.

5. **Create the commit**:
   - Use a HEREDOC to pass the message to ensure correct formatting.
   - Never amend an existing commit unless the user explicitly requests it.
   - Never use `--no-verify` or skip hooks unless the user explicitly requests it.

6. **Verify**:
   - Run `git status` after committing to confirm success.
   - If a pre-commit hook fails, fix the issue, re-stage, and create a NEW commit.

## Output

Report what was committed, summarizing file changes and the commit message used.
