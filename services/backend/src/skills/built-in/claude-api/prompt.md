# Claude API — Anthropic API Usage Guide

## Purpose
Provide guidance on using the Anthropic API, selecting Claude models, leveraging tool use, and following best practices.

## Topics

### Model Selection
- **Claude Opus 4**: Most capable model. Best for complex reasoning, coding, and multi-step tasks.
- **Claude Sonnet 4**: Balanced performance and speed. Good default for most tasks.
- **Claude Haiku 3.5**: Fastest and most cost-effective. Best for simple tasks and high-volume use.

### API Basics
- Base URL: `https://api.anthropic.com/v1/messages`
- Authentication: `x-api-key` header with your API key
- Required headers: `anthropic-version: 2023-06-01`, `content-type: application/json`
- Key parameters: `model`, `messages`, `max_tokens`, `system`

### Tool Use (Function Calling)
- Define tools in the `tools` array with `name`, `description`, and `input_schema`
- The model returns `tool_use` content blocks when it wants to call a tool
- Send tool results back as `tool_result` content blocks
- Support for parallel tool calls and sequential chains

### Best Practices
- Use the system prompt for persistent instructions and context
- Set `max_tokens` appropriately to avoid truncation
- Use streaming (`stream: true`) for better user experience on long responses
- Implement exponential backoff for rate limit errors (429)
- Cache system prompts with prompt caching to reduce costs
- Use `stop_sequences` to control output format

### Common Patterns
- **Multi-turn conversation**: Maintain the full message history
- **Structured output**: Use tool use to get JSON responses
- **Extended thinking**: Enable `thinking` for complex reasoning tasks
- **Batch API**: Use `/v1/messages/batches` for high-volume async processing

## Guidelines
- Always check the latest API documentation for current model names and features.
- Include practical code examples in Python or JavaScript when explaining concepts.
- Mention pricing considerations when recommending models.
