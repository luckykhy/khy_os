# Stage 3: Implementation

## Objective
Generate the complete CLI source code based on the architecture design.

## Inputs
- `architecture.json` from Stage 2

## Python Implementation

Generate the following file structure:
```
cli_anything/<SOFTWARE>/
├── __init__.py          # version, metadata
├── __main__.py          # python -m entry
├── <SOFTWARE>_cli.py    # Click CLI with all command groups
├── core/
│   ├── __init__.py
│   ├── project.py       # Project management (create, open, save)
│   ├── session.py       # Undo/redo session with deep-copy snapshots
│   └── export.py        # Export/render operations
├── utils/
│   ├── __init__.py
│   ├── backend.py       # find_exe() + subprocess wrapper
│   └── repl_skin.py     # Optional REPL mode
└── skills/
    └── SKILL.md          # (generated in Stage 6)
```

### Key Implementation Rules

1. **backend.py**: `find_exe(<SOFTWARE>)` searches PATH, common install locations, env vars
2. **session.py**: `SessionManager` with `copy.deepcopy(state)` before each mutation
3. **<SOFTWARE>_cli.py**: Every `@click.command()` has `@click.option('--json', 'as_json', is_flag=True)`
4. **Error handling**: Try/except around all subprocess calls, return structured errors

## Node.js Implementation

Generate the following file structure:
```
khy-cli-<SOFTWARE>/
├── openclaw.plugin.json   # KHY extension manifest
├── package.json
├── src/
│   ├── index.js           # Commander CLI + KHY command registration
│   ├── core/
│   │   ├── project.js     # Project management
│   │   ├── session.js     # Undo/redo session
│   │   └── export.js      # Export operations
│   └── backend.js         # find executable + child_process wrapper
├── skills/
│   ├── manifest.json
│   └── prompt.md
└── tests/
```

### Key Implementation Rules

1. **backend.js**: `findExe()` uses `which` + common paths, `execFileSync` with timeout
2. **session.js**: `structuredClone(state)` before each mutation
3. **index.js**: Commander CLI with `.option('--json', 'JSON output')`
4. **openclaw.plugin.json**: Registers as KHY extension with commands

## Output
- Complete source tree at `~/.khy/cli-anything/generated/<SOFTWARE>/`
