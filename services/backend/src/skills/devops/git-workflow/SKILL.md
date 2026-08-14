---
name: git-workflow
version: 1.0.0
description: Git workflow management — branching strategies, commit conventions, merge/rebase, conflict resolution, and CI/CD integration. Triggered for version control tasks.
layer: application
lifecycle: development
category: devops
tags: [git, workflow, branching, ci-cd, version-control]
platforms: [khy-quant, claude-code, cosh]
dependencies: []
---

# Git Workflow Skill

Version control best practices and workflow automation.

## When to Activate

- User asks about branching strategies
- User needs help with merge conflicts
- User wants to set up commit conventions
- User asks about CI/CD integration
- User mentions git rebase, cherry-pick, or bisect

## Workflow Patterns

### Branch Naming Convention
```
feature/<ticket-id>-<short-desc>
bugfix/<ticket-id>-<short-desc>
hotfix/<version>-<short-desc>
release/<version>
```

### Commit Message Format
```
<type>(<scope>): <subject>

<body>

<footer>
```
Types: feat, fix, docs, style, refactor, perf, test, chore, ci

### Common Operations

#### Feature Branch Workflow
```bash
git checkout -b feature/add-backtest-engine
# ... work ...
git add -p
git commit -m "feat(backtest): add multi-strategy engine"
git push -u origin feature/add-backtest-engine
```

#### Interactive Rebase (cleanup before merge)
```bash
git rebase -i HEAD~5
# squash, reword, fixup as needed
```

#### Conflict Resolution
```bash
git merge main
# resolve conflicts in editor
git add <resolved-files>
git merge --continue
```

### CI/CD Integration
- Pre-commit hooks: lint, format, type-check
- Pre-push hooks: test suite
- Branch protection: require reviews, passing CI

## Safety Rules

- Never force-push to main/master without team agreement
- Always back up branches before destructive rebases
- Use `--dry-run` for large-scale operations
- Prefer merge commits over squash for audit trails
