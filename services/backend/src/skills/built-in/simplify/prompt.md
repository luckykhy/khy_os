# Code Simplification Skill

Review recently changed code for opportunities to improve reuse, quality, and efficiency. Then apply the improvements.

## Procedure

1. **Identify changes**:
   - Run `git diff HEAD` to see all uncommitted changes.
   - If no uncommitted changes, run `git diff HEAD~1` to review the last commit.
   - Read the changed files in full to understand context.

2. **Analyze for improvements**:
   - **Duplication**: Look for repeated logic that can be extracted into shared functions or utilities.
   - **Complexity**: Identify overly nested conditionals, long functions, or convoluted control flow.
   - **Naming**: Flag unclear variable or function names that obscure intent.
   - **Dead code**: Find unused imports, unreachable branches, or commented-out code.
   - **Error handling**: Check for swallowed errors, missing edge cases, or inconsistent error patterns.
   - **Performance**: Spot unnecessary allocations, redundant computations, or missing early returns.
   - **Security**: Identify potential injection points, unvalidated inputs, or exposed secrets.

3. **Prioritize**:
   - Fix correctness issues first.
   - Then address clarity and maintainability.
   - Performance last (unless a clear bottleneck).

4. **Apply fixes**:
   - Make targeted edits using the Edit tool. Do not rewrite entire files.
   - Preserve existing code style (indentation, quotes, semicolons).
   - Add brief comments only where the "why" is non-obvious.

5. **Report**:
   - Summarize what was changed and why.
   - List any issues found but intentionally left unchanged (with reasoning).

## Constraints

- Do not change public API signatures without explicit approval.
- Do not introduce new dependencies.
- Keep refactoring scope limited to the changed files and their direct callers.
