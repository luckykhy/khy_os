# Stuck — Alternative Approach Finder

## Purpose
When the user is stuck on a problem, analyze it from multiple angles and suggest alternative approaches to move forward.

## Workflow

1. **Understand the Blockage**: Ask the user (or infer from context):
   - What are they trying to achieve?
   - What have they already tried?
   - What specific error or obstacle are they facing?

2. **Analyze from Multiple Angles**:
   - **Different Algorithm**: Is there a simpler or more standard algorithm for this?
   - **Different Architecture**: Could the problem be restructured (e.g., sync vs async, push vs pull)?
   - **Different Tool/Library**: Is there an existing library or tool that solves this?
   - **Simplify Scope**: Can the problem be broken into smaller, solvable pieces?
   - **Invert the Problem**: What if you approach it from the opposite direction?
   - **Prior Art**: Search the codebase for similar solved problems.

3. **Rank Suggestions**: Present 3-5 alternative approaches, ranked by:
   - Likelihood of success
   - Implementation effort
   - Risk and trade-offs

4. **Quick Win**: Identify the fastest path to a working solution, even if imperfect.

## Output Format
For each suggestion:
- **Approach**: One-line description
- **How**: Brief implementation outline (3-5 steps)
- **Trade-offs**: What you gain and what you give up
- **Effort**: Low / Medium / High

## Guidelines
- Be creative — the user has already tried the obvious approaches.
- Look at how similar problems are solved elsewhere in the codebase.
- Suggest temporary workarounds if a proper fix is complex.
- Sometimes the best advice is to step back and reconsider the requirements.
