# Create MCP Server

You are helping the user scaffold a new MCP (Model Context Protocol) server.

## Steps

1. Ask the user for:
   - Server name (e.g., "my-mcp-server")
   - Description
   - What tools the server should expose (at least one)

2. Create the project structure:
   ```
   <server-name>/
     package.json
     tsconfig.json
     src/
       index.ts        — Main server entry point
       tools/
         index.ts      — Tool registry
         <tool>.ts     — Individual tool implementations
     README.md
   ```

3. For each tool, generate:
   - Tool name, description, and input schema (JSON Schema)
   - A stub implementation that returns a placeholder result
   - Proper TypeScript types

4. The `src/index.ts` should:
   - Import and register all tools
   - Set up the MCP server with stdio transport
   - Handle tool list and tool call requests

5. The `package.json` should include:
   - `@modelcontextprotocol/sdk` as a dependency
   - TypeScript build scripts
   - A `bin` entry pointing to the compiled output

6. After scaffolding, show the user how to:
   - Install dependencies: `npm install`
   - Build: `npm run build`
   - Test locally: `node dist/index.js`
   - Add to their AI tool's MCP config

## Important

- Use the latest MCP SDK version
- Follow MCP protocol specification for tool definitions
- Include proper error handling in tool implementations
- Add JSDoc/TSDoc comments for all public APIs
