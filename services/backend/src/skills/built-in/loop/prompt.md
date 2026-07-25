# Loop — Iterative Test-Fix Cycle

## Purpose
Iteratively improve code by running tests, fixing failures, and repeating until all tests pass. Enforces a maximum iteration limit to prevent infinite loops.

## Workflow

1. **Initialize**: Set iteration counter to 0. Maximum iterations: 10.
2. **Run Tests**: Execute the project's test suite:
   - Detect test runner from project config (package.json, Makefile, pyproject.toml).
   - Run the full suite or targeted tests if specified by the user.
3. **Evaluate Results**:
   - If all tests pass: report success and exit.
   - If tests fail: proceed to fix step.
   - If iteration count >= 10: stop and report remaining failures.
4. **Fix Failures**:
   - Analyze each failing test's error message and stack trace.
   - Identify the root cause in the source code (not the test).
   - Apply the minimal fix needed.
   - Increment iteration counter.
5. **Repeat**: Go back to step 2.

## Progress Reporting
After each iteration, report:
- Iteration number (e.g., "Iteration 3/10")
- Tests passed / total
- What was fixed in this iteration
- Remaining failures

## Guidelines
- Fix source code, not tests (unless the test itself is clearly wrong).
- Apply one fix per iteration to keep changes traceable.
- If the same test fails 3 times with different fixes, flag it for manual review.
- Never disable or skip tests to make them "pass."
- After completion, show a summary of all changes made across iterations.
- If no test runner is found, ask the user how to run tests before starting.
