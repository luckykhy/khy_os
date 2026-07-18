# Stage 0: Source Acquisition

## Objective
Acquire the target software source code for analysis.

## Inputs
- `repoOrPath`: Git URL or local filesystem path

## Steps

1. If `repoOrPath` is a URL (starts with `http://`, `https://`, `git@`):
   - Clone to `~/.khy/cli-anything/generated/<SOFTWARE>/source/`
   - Use `git clone --depth 1` for efficiency
   - Extract `<SOFTWARE>` name from the URL (last path segment, strip `.git`)

2. If `repoOrPath` is a local path:
   - Verify the path exists and contains source files
   - Create a symlink or copy to the working directory
   - Infer `<SOFTWARE>` name from the directory name

3. Detect the software's primary language and build system:
   - Python: `setup.py`, `pyproject.toml`, `requirements.txt`
   - Node.js: `package.json`
   - C/C++: `CMakeLists.txt`, `Makefile`, `configure`
   - Rust: `Cargo.toml`
   - Go: `go.mod`
   - Other: README, docs

4. Verify the software can be invoked (has a CLI entry point or library API)

## Output
- `stage0_result.json`:
  ```json
  {
    "software": "<name>",
    "sourcePath": "<path>",
    "language": "<primary language>",
    "buildSystem": "<build tool>",
    "entryPoints": ["<detected CLI commands or main modules>"],
    "hasTests": true/false,
    "hasDocs": true/false
  }
  ```
