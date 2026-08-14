# Stage 7: Packaging & Registration

## Objective
Create distributable package, install locally, and register with KHY OS.

## Inputs
- Complete source tree from Stage 3-6

## Python Packaging

1. **Generate `setup.py`**:
   ```python
   from setuptools import setup, find_namespace_packages

   setup(
       name='cli-anything-<SOFTWARE>',
       version='1.0.0',
       packages=find_namespace_packages(include=['cli_anything.*']),
       entry_points={
           'console_scripts': [
               'cli-anything-<SOFTWARE>=cli_anything.<SOFTWARE>.<SOFTWARE>_cli:cli',
           ],
       },
       install_requires=['click>=8.0'],
       python_requires='>=3.8',
   )
   ```

2. **Install locally**: `pip install -e .`

3. **Verify installation**: `cli-anything-<SOFTWARE> --version`

## Node.js Packaging

1. **Ensure `package.json`** has:
   ```json
   {
     "name": "khy-cli-<SOFTWARE>",
     "version": "1.0.0",
     "bin": { "cli-anything-<SOFTWARE>": "./src/index.js" },
     "main": "./src/index.js"
   }
   ```

2. **Install locally**: `npm link`

3. **Verify installation**: `cli-anything-<SOFTWARE> --version`

## KHY OS Registration

After successful install, the system automatically:

1. **Discovers** the new CLI via `discoverInstalled()`
2. **Registers as KHY App** via `appRegistry.register()` with `runtime: 'external'`
3. **Registers as KHY Tool** via `defineTool()` with `cli_anything__<SOFTWARE>` name
4. **Converts SKILL.md** to KHY skill at `~/.khy/skills/cli-anything-<SOFTWARE>/`

## Verification

```bash
khy app cli-list                # Should show the new CLI
khy skill list                  # Should show cli-anything-<SOFTWARE> skill
khy app cli-invoke <SOFTWARE> --help  # Should display help
```

## Output
- Installable package
- CLI registered in KHY OS tool/skill/app registries
