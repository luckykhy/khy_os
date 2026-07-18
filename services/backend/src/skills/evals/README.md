# Skill Eval Baseline

This directory defines the first repeatable skill quality gate inspired by the
oh-my-openagent eval workflow.

## Files

- `skill-eval-config.schema.json`: schema for baseline config structure
- `skill-eval-baseline.json`: initial scoring checks and CI thresholds
- `skill-eval-report.schema.json`: schema for generated report payload
- `skill-scenario-suite.json`: scenario assertions over skill prompt behavior
- `skill-scenario-report.schema.json`: schema for scenario report payload

## Runner

Run from repository root:

```bash
node scripts/ci/check-skill-evals.js
```

Optional report output:

```bash
node scripts/ci/check-skill-evals.js --report docs/报告/技能评估-最新.json
```

Scenario eval:

```bash
node scripts/ci/check-skill-scenarios.js --report docs/报告/技能场景评估-最新.json
```

## What This Baseline Checks

- Manifest required fields (`name`, `description`, `trigger`/`command`)
- Invocable flag consistency (`user_invocable` or `userInvocable`)
- Prompt asset presence (`prompt.md`)
- Metadata quality fields (`tags`, `category`, `platforms`)
- Prompt-level scenario assertions for key built-in skills (verify, commit, loop, stuck, remember)

## Pass Conditions

Thresholds are loaded from `skill-eval-baseline.json` and enforced in CI.
If any threshold fails, the script exits with non-zero status.
