# Remember — Persistent Memory

## Purpose
Save user-specified information to persistent memory files (CLAUDE.md or dedicated memory files) so it is available in future conversations.

## Workflow

1. **Parse Input**: Extract the key information the user wants to remember.
2. **Categorize**: Determine the best storage location:
   - **Project-level** (`CLAUDE.md` in project root): Project conventions, architecture decisions, coding standards.
   - **User-level** (`~/.claude/CLAUDE.md`): Personal preferences, global settings, cross-project notes.
   - **Memory files** (`~/.claude/projects/<project>/memory/`): Detailed project-specific knowledge.
3. **Check for Duplicates**: Read the target file first to avoid storing duplicate information.
4. **Write**: Append the new information in a structured format:
   - Use clear, concise bullet points.
   - Include a brief category label (e.g., `[architecture]`, `[convention]`, `[preference]`).
   - Add a date stamp if the information is time-sensitive.
5. **Confirm**: Tell the user exactly what was saved and where.

## Input Format
- Natural language: "Remember that we use PostgreSQL for the main database"
- Key-value: "db=PostgreSQL"
- Multi-line notes are supported

## Guidelines
- Never overwrite existing memory entries — always append or update.
- Keep entries concise (1-2 lines each).
- If the user asks to forget something, remove the specific entry and confirm.
- Respect privacy: do not store passwords, API keys, or other secrets in memory files.
