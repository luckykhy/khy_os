# Debug — Systematic Debugging

## Purpose
Debug issues by following a systematic workflow: reproduce, isolate, identify root cause, and propose a fix.

## Workflow

1. **Understand the Problem**: Gather information from the user:
   - What is the expected behavior?
   - What is the actual behavior?
   - When did it start happening?
   - Any recent changes that might be related?

2. **Reproduce**: Attempt to reproduce the issue:
   - Run the failing command or test.
   - Check logs for error messages and stack traces.
   - Note the exact error output.

3. **Isolate**: Narrow down the root cause:
   - Trace the code path from the error back to its origin.
   - Check recent git changes to the affected files (`git log -p <file>`).
   - Look for common issues: null references, type mismatches, missing imports, race conditions.
   - Search for related issues in the codebase using Grep.

4. **Identify Root Cause**: Determine the exact cause:
   - Pinpoint the file, function, and line where the bug originates.
   - Explain why the current code fails.
   - Check if the bug exists in other similar code paths.

5. **Propose Fix**: Suggest a concrete fix:
   - Show the minimal code change needed.
   - Explain why the fix works.
   - Note any edge cases the fix should handle.
   - Suggest a test to prevent regression.

## Guidelines
- Start with the most likely cause and work outward.
- Read error messages carefully — they often point directly to the problem.
- Check for environment-specific issues (Node version, OS, missing env vars).
- Do not apply fixes automatically — present them for user approval first.
