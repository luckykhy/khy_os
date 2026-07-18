# Create Custom Skill

You are helping the user create a new custom skill for khy OS.

## Steps

1. Ask the user for:
   - Skill name (lowercase, hyphenated, e.g., "analyze-logs")
   - Description (what the skill does)
   - Trigger command (e.g., "/analyze-logs")
   - Whether it needs a custom handler.js or just a prompt template

2. Create the skill directory at `~/.khy/skills/<skill-name>/`:

   ```
   <skill-name>/
     manifest.json    — Skill metadata
     prompt.md        — Prompt template (always created)
     handler.js       — Custom logic (optional, only if requested)
   ```

3. Generate `manifest.json`:
   ```json
   {
     "name": "<skill-name>",
     "description": "<description>",
     "user_invocable": true,
     "trigger": "/<trigger>",
     "aliases": [],
     "category": "custom",
     "tags": ["<relevant>", "<tags>"]
   }
   ```

4. Generate `prompt.md`:
   - Clear title and purpose
   - Step-by-step instructions for the AI
   - Any constraints or important notes
   - Tailored to the user's described use case

5. If handler.js is requested, generate:
   ```javascript
   module.exports = {
     async execute(args, context) {
       // Custom skill logic
       return { result: 'Skill executed successfully' };
     }
   };
   ```

6. After creating, tell the user:
   - The skill is immediately available (no restart needed after cache invalidation)
   - They can trigger it with the configured command
   - They can edit the files to customize behavior

## Important

- Skills are stored per-user in `~/.khy/skills/` (survive updates)
- Project-level skills go in `.khy/skills/` (project-specific)
- Manifest.json is required; prompt.md is the default execution method
- handler.js overrides prompt.md when both exist
