# Initialize Project

You are helping the user initialize a new software project with best practices.

## Steps

1. Determine the project type by asking the user or inferring from context:
   - Language/runtime: Node.js, Python, Go, Rust, etc.
   - Framework: React, Vue, Express, FastAPI, etc.
   - Project type: library, CLI tool, web app, API server, etc.

2. Create the project structure appropriate for the language:
   - Source directory (src/, lib/, etc.)
   - Test directory (tests/, __tests__/, etc.)
   - Configuration files

3. Initialize essential tooling:
   - **Git**: `git init` + `.gitignore` with language-specific patterns
   - **Package manager**: package.json / pyproject.toml / go.mod / Cargo.toml
   - **Linting**: ESLint / Ruff / golangci-lint / clippy config
   - **Formatting**: Prettier / Black / gofmt config
   - **Testing**: Jest / pytest / go test setup

4. Add documentation:
   - README.md with project name, description, setup instructions
   - CLAUDE.md with project conventions for AI assistants

5. Create initial source files:
   - Entry point (index.ts, main.py, main.go, etc.)
   - A simple example or hello-world implementation

## Important

- Follow the language community's conventions and best practices
- Use the latest stable versions of dependencies
- Keep the initial setup minimal but complete
- Do NOT add unnecessary complexity or over-engineer
- Ask before choosing between alternatives (e.g., npm vs pnpm, Jest vs Vitest)
