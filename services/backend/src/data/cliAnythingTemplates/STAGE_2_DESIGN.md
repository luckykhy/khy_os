# Stage 2: Architecture Design

## Objective
Design the CLI command structure, state model, and output format based on the SOP analysis.

## Inputs
- `<SOFTWARE>.md` from Stage 1

## Steps

1. **Design Command Groups** — map each workflow to a Click/Commander command group:
   ```
   cli-anything-<SOFTWARE>
   ├── project    (create, open, save, close, info)
   ├── <domain1>  (domain-specific commands)
   ├── <domain2>  (domain-specific commands)
   ├── export     (render, compile, convert)
   └── session    (undo, redo, history, snapshot)
   ```

2. **Design State Model**:
   - What is the "project" concept? (file, workspace, session)
   - What state changes between commands? (selections, settings, layers)
   - Deep-copy undo/redo: each command snapshots state before execution

3. **Design Output Format**:
   - Human-readable: clear terminal output with color hints
   - JSON (`--json`): structured output for agent consumption
   ```json
   {
     "status": "success|error",
     "command": "<command.subcommand>",
     "data": { ... },
     "metadata": { "duration_ms": 123, "software_version": "x.y.z" }
   }
   ```

4. **Design Backend Calls**:
   - Map each command to specific software invocations
   - Define subprocess timeout per command category
   - Define error detection patterns (exit codes, stderr patterns)

5. **Generate `architecture.json`**:
   ```json
   {
     "commandGroups": [...],
     "stateModel": {...},
     "outputFormat": {...},
     "backendCalls": [...]
   }
   ```

## Output
- `architecture.json` — the complete design specification
