# Command Authoring Guide

> How to add a new CLI command to Khy OS using the self-registration system.

## The Problem We're Solving

Before this system, adding a command meant editing **6 files**:

1. `handlers/yourcmd.js` — the implementation
2. `router.js` — add a `case 'yourcmd':` branch
3. `constants/commandSchema.js` — add to `ROUTER_COMMANDS`
4. `aliases.js` — add Chinese/pinyin aliases
5. Possibly `routerDispatch*.js` — if it belongs to a cluster
6. Possibly `constants/commandSchema.js` → sub-commands

Now you only need **1 file**: the handler. Aliases declared in the manifest are
auto-injected into the alias resolution system — no edit to `aliases.js` needed.

> **Alias collision rule**: if a manifest alias collides with an existing static
> alias in `aliases.js`, the static alias wins (it may carry `subCommand` /
> `defaultArgs` that the manifest form can't express). Choose aliases that don't
> collide with existing ones.

## Quick Start

Create `handlers/myfeature.js`:

```js
'use strict';

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');

async function handleMyFeature(parsed, ctx) {
  const { printSuccess, printInfo } = ctx;
  printSuccess('Hello from my feature!');
  printInfo('Usage: khy myfeature [args]');
  return true;
}

module.exports = {
  handleMyFeature,
  [MANIFEST_EXPORT_KEY]: {
    name: 'myfeature',
    aliases: ['mf', '我的功能'],
    description: 'One-line description shown in help',
    usage: 'myfeature [args]',
    category: 'extension',
    handler: handleMyFeature,
  },
};
```

That's it. `khy myfeature` now works. No router.js edit needed.

## Manifest Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | **yes** | string | Canonical command name. Must be `kebab-case` (lowercase a-z, digits, hyphens). |
| `handler` | **yes** | function | `async (parsed, ctx) => boolean` — the dispatch function. |
| `aliases` | no | string[] | Chinese, pinyin, or English shortcuts. |
| `description` | no | string | One-line help text. |
| `usage` | no | string | Usage line shown in help. Defaults to `name`. |
| `subCommands` | no | string[] | Valid sub-command names (for validation/help). |
| `category` | no | string | One of: `system`, `data`, `trading`, `ai`, `dev`, `workflow`, `extension`. Default: `extension`. |

## Handler Signature

```js
async function handler(parsed, ctx) {
  // parsed: { command, subCommand, args, options, rawCommandToken }
  // ctx: { printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner, chalk, ... }

  const { printSuccess, printInfo } = ctx;
  const args = parsed.args || [];
  const opts = parsed.options || {};

  // Return true on success, false to fall through to AI.
  return true;
}
```

## Naming Conventions

- **Command name**: `kebab-case`, verb prefix preferred (`data-fetch`, `strategy-list`, `disk-clean`)
- **Handler function**: `handleXxx` (camelCase, e.g. `handleDataFetch`)
- **File name**: match the command name (`data-fetch.js`, not `dataFetch.js`)
- **Aliases**: include at least one Chinese alias for discoverability

## When NOT to Use Self-Registration

The hardcoded switch in `router.js` still exists and is still valid for:

- **Multi-command handlers**: one module that handles several related commands (e.g. `gateway` with 20+ sub-commands)
- **Commands that need inline implementation**: when the case body is < 10 lines and doesn't warrant a separate file
- **Commands with complex dispatch logic**: when the routing depends on runtime state beyond `parsed`

For these, the traditional pattern (add case to switch) still works.

## Migration Path

Existing commands can be migrated incrementally:

1. Add a manifest export to the handler
2. Test that `khy <command>` works via the auto-registry
3. Remove the `case` branch from `router.js` (optional — the auto-registry runs first, so the dead case is harmless)

## Schema auto-supplement

`commandSchema.js` (`getRouterCommandNames()`, `getRouterSubCommands()`) automatically
includes commands and sub-commands declared in manifests. This means:

- New commands appear in fuzzy matching and Tab completion without manual registration
- `getCommandSchema()` (used by lint/test/introspection) includes manifest commands
- Static entries always take precedence; manifest entries fill the gaps

## Architecture

```
User input → parseInput()
             → route(command)
               → dispatchOpsCommand()     (18 ops commands)
               → dispatchSlashCommand()   (55 slash commands)
               → dispatchTailCommand()    (38 tail commands)
               → commandAutoRegistry.dispatch()  ← self-registering commands
               → switch(command)           (legacy, shrinking over time)
               → default: fuzzy match → AI
```

The auto-registry scans `handlers/` at startup, imports each module, and checks for a manifest under the key `__khyCommandManifest`. Valid manifests are registered in a dispatch map. At route time, the registry is consulted before the switch.

**Alias auto-injection**: when a manifest declares `aliases`, those aliases are
automatically available to `resolveAlias()`, `getAliasesForCommand()`, and
`getAllAliasKeys()` — no static entry in `aliases.js` needed. The static alias
table always takes precedence on collision.

**Schema auto-supplement**: `getRouterCommandNames()` and `getRouterSubCommands()`
merge manifest declarations, so new commands participate in fuzzy matching,
completion, and introspection without touching `commandSchema.js`.

## Files

| File | Role |
|------|------|
| `cli/commandManifest.js` | Schema definition, validation, extraction |
| `cli/commandAutoRegistry.js` | Scanner, registry, dispatcher |
| `cli/router.js` | Integration point (calls `commandAutoRegistry.dispatch()`) |
| `cli/handlers/*.js` | Individual command implementations |
