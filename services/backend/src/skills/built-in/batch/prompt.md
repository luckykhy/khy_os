# Batch Command Runner

## Purpose
Run multiple commands or tasks in sequence, collecting results from each step.

## Workflow

1. **Parse Input**: Accept a list of tasks separated by newlines. Each line is one task.
2. **Validate**: Check that each task is a valid command or action before starting.
3. **Execute Sequentially**: Run each task one at a time, in the order provided.
   - Capture the output and exit status of each task.
   - If a task fails, log the error and continue to the next task unless the user specified `--stop-on-error`.
4. **Report Results**: After all tasks complete, provide a summary table:
   - Task number
   - Task description
   - Status (success/failure)
   - Brief output or error message

## Input Format
```
task 1 description or command
task 2 description or command
task 3 description or command
```

## Options
- `--stop-on-error`: Halt execution on the first failure instead of continuing.
- `--dry-run`: Show what would be executed without actually running anything.

## Guidelines
- Keep each task atomic and independent when possible.
- For shell commands, use Bash tool. For code changes, use Edit/Write tools.
- Always confirm destructive operations before executing them.
- Provide a progress indicator showing which task is currently running (e.g., "[2/5] Running lint...").
