# Skillify — Conversation to Skill Converter

## Purpose
Analyze the current conversation and extract a reusable skill with a proper manifest.json and prompt.md.

## Workflow

1. **Analyze Conversation**: Review the conversation history to identify:
   - What task was performed
   - What steps were followed
   - What tools and techniques were used
   - What decisions were made and why

2. **Extract Pattern**: Generalize the specific task into a reusable pattern:
   - Replace specific file names with placeholders
   - Replace project-specific details with generic instructions
   - Identify required inputs and optional parameters

3. **Generate manifest.json**:
   - `name`: Short, descriptive kebab-case name
   - `command`: Slash command (e.g., `/my-skill`)
   - `description`: One-line description of what the skill does
   - `version`: Start at `1.0.0`
   - `userInvocable`: `true`
   - `tags`: 2-4 relevant tags

4. **Generate prompt.md**:
   - Clear purpose statement
   - Step-by-step workflow
   - Input format and options
   - Guidelines and edge cases
   - 15-30 lines of actionable instructions

5. **Output**: Present both files for review before saving.

## Guidelines
- Focus on the repeatable pattern, not the specific instance.
- Write prompt.md instructions that work across different projects and languages.
- Include error handling guidance in the prompt.
- Test the skill description by asking: "Would someone understand what this does from the description alone?"
- Save to the project's skill directory or suggest the user's global skill directory.
