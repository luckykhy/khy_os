# Contributing to Khy-OS

Thanks for your interest in contributing! Please refer to [AGENTS.md](../AGENTS.md) for the main developer guide, architecture overview, and contribution workflows.

## Quick Start

1. Fork the repository
2. Run `npm install` at the project root
3. Initialize the database: `cd services/backend && node setup.js`
4. Start developing: `cd services/backend && node server.js` (or `npm run dev` if nodemon is configured)

## Code Quality

- JavaScript: ESLint + Prettier
- Python: flake8 + black
- Shell scripts: shellcheck

## Pull Request Process

1. Update documentation if needed
2. Add tests for new features
3. Ensure all CI checks pass
4. Get review from a maintainer

## License

This project uses a source-available license. See LICENSE file for details.
