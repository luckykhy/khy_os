/* khy-tools.js — the single definition of the OS capability surface.
 *
 * One source of truth for "what an agent can do to KHY-OS", expressed as a list
 * of tool descriptors { name, description, inputSchema, handler }. Both agents
 * consume this exact list:
 *   - the built-in KHY Node agent (khy-agent.js) calls the handlers in-process;
 *   - an external agent (Claude Code) reaches the same handlers over MCP
 *     (khy-mcp.js maps each descriptor to an MCP tool).
 * Neither duplicates protocol logic — every handler just calls a KhyBridge
 * method, so the control plane stays the one path to the kernel (requirement 1).
 *
 * inputSchema is JSON Schema (the shape MCP and most tool registries expect), so
 * the project's existing gateway/adapter infrastructure can mount these
 * descriptors directly without translation.
 */
'use strict';

/* Build the tool surface bound to a connected KhyBridge. Returns an array of
 * descriptors; handlers are async and return a plain JSON-serializable value. */
function makeTools(bridge) {
  return [
    {
      name: 'khy_list',
      description: 'List a directory in KHY-OS. Returns entries with name, type (file|dir) and size.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path, e.g. "/" or "/etc"' } },
        required: ['path'],
      },
      handler: (args) => bridge.list(args.path),
    },
    {
      name: 'khy_stat',
      description: 'Stat a path in KHY-OS. Returns type, mode, uid, gid, size and timestamps.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: (args) => bridge.stat(args.path),
    },
    {
      name: 'khy_read',
      description: 'Read a whole file from KHY-OS and return its text content.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: async (args) => (await bridge.read(args.path)).toString('utf8'),
    },
    {
      name: 'khy_write',
      description: 'Write (or append to) a file in KHY-OS. Returns the number of bytes written.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          data: { type: 'string', description: 'UTF-8 content to write' },
          append: { type: 'boolean', description: 'Append instead of overwrite (default false)' },
        },
        required: ['path', 'data'],
      },
      handler: (args) => bridge.write(args.path, args.data, { append: !!args.append }),
    },
    {
      name: 'khy_mkdir',
      description: 'Create a directory in KHY-OS.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: (args) => bridge.mkdir(args.path),
    },
    {
      name: 'khy_remove',
      description: 'Remove a file or empty directory in KHY-OS.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: (args) => bridge.remove(args.path),
    },
    {
      name: 'khy_ps',
      description: 'List the KHY-OS process table. Returns pid, tid, state, isUser and name for each process.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => bridge.ps(),
    },
    {
      name: 'khy_get_config',
      description: 'Read the persisted agent config (/disk/etc/agent.conf) as a key/value object — '
        + 'e.g. which model/endpoint the system is configured to use.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => bridge.readConfig(),
    },
  ];
}

module.exports = { makeTools };
