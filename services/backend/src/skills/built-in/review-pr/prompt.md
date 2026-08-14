# Pull Request Review Skill

Perform a thorough code review of a pull request.

## Inputs

- A PR number (e.g., `123`) or a GitHub PR URL.
- If no input is provided, review the current branch against the base branch.

## Procedure

1. **Gather context**:
   - If a PR number/URL is given, use `gh pr view <number> --json` to fetch PR metadata.
   - Use `gh pr diff <number>` to get the full diff.
   - If reviewing the current branch, use `git log main..HEAD --oneline` and `git diff main...HEAD`.

2. **Understand the change**:
   - Read the PR description and linked issues.
   - Identify the intent: bug fix, feature, refactor, config change, etc.
   - Determine the scope: which subsystems are touched.

3. **Review checklist**:
   - **Correctness**: Does the code do what it claims? Are edge cases handled?
   - **Security**: Are inputs validated? Any injection risks? Secrets exposed?
   - **Performance**: Any O(n^2) loops, unnecessary allocations, missing caches?
   - **Error handling**: Are errors propagated correctly? Missing try/catch?
   - **Testing**: Are tests added or updated? Do they cover the happy path and failure cases?
   - **Style**: Does the code follow project conventions? Consistent naming?
   - **Documentation**: Are public APIs documented? Are complex algorithms explained?
   - **Dependencies**: Are new dependencies justified? Are they well-maintained?
   - **Breaking changes**: Any backwards-incompatible changes to public interfaces?

4. **Output format**:
   Provide a structured review:

   ```
   ## Summary
   Brief description of what the PR does.

   ## Findings

   ### Critical
   - [file:line] Description of critical issue

   ### Suggestions
   - [file:line] Description of improvement suggestion

   ### Praise
   - Highlight well-done aspects

   ## Verdict
   APPROVE / REQUEST_CHANGES / COMMENT
   ```

## Constraints

- Be constructive. Explain the "why" behind every suggestion.
- Distinguish between blocking issues and stylistic preferences.
- Acknowledge good patterns and thoughtful decisions.
