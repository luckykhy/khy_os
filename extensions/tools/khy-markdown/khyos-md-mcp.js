#!/usr/bin/env node
'use strict';
/**
 * khyos-md-mcp.js — MCP (Model Context Protocol) server for khyosMarkdown.
 * Zero-dependency stdio JSON-RPC 2.0 implementation.
 *
 * 协议要点：
 *   - stdin  读取换行分隔的 JSON-RPC 2.0 消息（每行一个 JSON 对象）
 *   - stdout 只输出协议消息（每行一个 JSON 对象，换行结尾）
 *   - stderr 用于日志
 *
 * Usage: node khyos-md-mcp.js [--root <dir>]
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'khyos-markdown', version: '1.0.0' };

// ── 根目录限制（安全：所有文件操作限制在 root 内）──
const rootArgIdx = process.argv.indexOf('--root');
const ROOT = rootArgIdx > -1 && process.argv[rootArgIdx + 1]
  ? path.resolve(process.argv[rootArgIdx + 1])
  : process.cwd();

function log(msg) { process.stderr.write('[khyos-md-mcp] ' + msg + '\n'); }

/**
 * 解析路径并强制限制在 ROOT 内。
 * Windows 防御：
 *   1. 统一 path.sep（防止 "/" 输入绕过 "\" 前缀检查）
 *   2. 剥离 \\?\ 长路径前缀（否则 startsWith 前缀检查失效）
 *   3. 不区分大小写，比较前统一转小写
 *   4. 以 path.sep 为边界，防止 "D:\root-evil" 绕过 "D:\root" 前缀检查
 */
function safePath(p) {
  let resolved = path.resolve(ROOT, String(p));
  // 剥离 Windows 长路径前缀 \\?\ （path.resolve 不会自动去掉）
  if (resolved.startsWith('\\\\?\\')) {
    resolved = resolved.slice(4);
  }
  // Windows：统一分隔符为 path.sep，确保前缀检查一致
  if (process.platform === 'win32') {
    resolved = resolved.replace(/\//g, '\\');
  }
  const a = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const b = process.platform === 'win32' ? ROOT.toLowerCase().replace(/\//g, '\\') : ROOT;
  // 去掉可能存在的 \\?\ 前缀后再比较
  const rootClean = b.startsWith('\\\\?\\') ? b.slice(4) : b;
  const prefix = rootClean.endsWith(path.sep) ? rootClean : rootClean + path.sep;
  if (a !== rootClean && !a.startsWith(prefix)) {
    throw new Error('路径越界：仅允许访问 ' + ROOT + ' 内的文件');
  }
  return resolved;
}

// ── 工具定义 ──
const TOOLS = [
  {
    name: 'read_markdown',
    description: '读取一个 Markdown 文件的内容。返回文件文本。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Markdown 文件路径（相对于根目录或绝对路径）' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_markdown',
    description: '写入/保存 Markdown 文件。目录不存在时自动创建。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标文件路径' },
        content: { type: 'string', description: '要写入的 Markdown 内容' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list_markdown',
    description: '递归列出目录下所有 Markdown 文件（.md/.markdown），返回相对路径列表。',
    inputSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '要列出的目录（默认根目录）' }
      }
    }
  },
  {
    name: 'search_markdown',
    description: '在目录下所有 Markdown 文件中全文搜索关键词，返回匹配的文件、行号和上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（大小写不敏感）' },
        dir: { type: 'string', description: '搜索目录（默认根目录）' }
      },
      required: ['query']
    }
  },
  {
    name: 'open_editor',
    description: '在 khyosMarkdown GUI 编辑器中打开一个 Markdown 文件（启动本地编辑器窗口，供人查看/编辑）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要打开的 Markdown 文件路径' }
      },
      required: ['path']
    }
  },
  {
    name: 'get_outline',
    description: '提取 Markdown 文件的标题大纲结构（各级标题及行号）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Markdown 文件路径' }
      },
      required: ['path']
    }
  }
];

/** 递归遍历目录，跳过隐藏目录与 node_modules */
function walkMarkdown(dir, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, onFile);
    else if (/\.(md|markdown)$/i.test(e.name)) onFile(full);
  }
}

// ── 工具实现 ──
async function callTool(name, args) {
  switch (name) {
    case 'read_markdown': {
      const p = safePath(args.path);
      const text = fs.readFileSync(p, 'utf8');
      return { content: [{ type: 'text', text }] };
    }
    case 'write_markdown': {
      const p = safePath(args.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content, 'utf8');
      return { content: [{ type: 'text', text: '已保存: ' + p + ' (' + Buffer.byteLength(args.content) + ' 字节)' }] };
    }
    case 'list_markdown': {
      const dir = args.dir ? safePath(args.dir) : ROOT;
      const files = [];
      walkMarkdown(dir, (full) => files.push(path.relative(ROOT, full)));
      return { content: [{ type: 'text', text: files.length ? files.join('\n') : '（未找到 Markdown 文件）' }] };
    }
    case 'search_markdown': {
      const dir = args.dir ? safePath(args.dir) : ROOT;
      const q = String(args.query).toLowerCase();
      const hits = [];
      walkMarkdown(dir, (full) => {
        if (hits.length >= 100) return;
        let lines;
        try { lines = fs.readFileSync(full, 'utf8').split('\n'); } catch (_) { return; }
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(q) && hits.length < 100) {
            hits.push(path.relative(ROOT, full) + ':' + (i + 1) + ': ' + line.trim().slice(0, 120));
          }
        });
      });
      return { content: [{ type: 'text', text: hits.length ? '找到 ' + hits.length + ' 处匹配:\n' + hits.join('\n') : '未找到 "' + args.query + '"' }] };
    }
    case 'open_editor': {
      const p = safePath(args.path);
      if (!fs.existsSync(p)) throw new Error('文件不存在: ' + p);
      const { spawn } = require('child_process');
      const bridgePath = path.join(__dirname, 'khyos-md-bridge.js');
      if (!fs.existsSync(bridgePath)) throw new Error('未找到编辑器桥接器: ' + bridgePath);
      // process.execPath 即当前 node 路径（MCP 服务器本身由 node 启动，直接复用）
      const child = spawn(process.execPath, [bridgePath, p], { detached: true, stdio: 'ignore' });
      child.unref();
      return { content: [{ type: 'text', text: 'khyosMarkdown 编辑器已启动，正在打开: ' + p }] };
    }
    case 'get_outline': {
      const p = safePath(args.path);
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      const outline = [];
      let inCode = false;
      lines.forEach((line, i) => {
        if (/^```/.test(line)) { inCode = !inCode; return; }
        if (inCode) return;
        const m = line.match(/^(#{1,6})\s+(.+)/);
        if (m) outline.push('  '.repeat(m[1].length - 1) + '- ' + m[2].trim() + ' (L' + (i + 1) + ')');
      });
      return { content: [{ type: 'text', text: outline.length ? outline.join('\n') : '（无标题）' }] };
    }
    default:
      throw new Error('未知工具: ' + name);
  }
}

// ── JSON-RPC 循环 ──
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function respond(id, result, error) {
  const msg = { jsonrpc: '2.0', id };
  if (error) msg.error = error;
  else msg.result = result;
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch (_) { return; }
  const { id, method, params } = req;

  try {
    if (method === 'initialize') {
      respond(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    } else if (method && method.startsWith('notifications/')) {
      // notifications: no response
    } else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      try {
        const result = await callTool(params.name, params.arguments || {});
        respond(id, result);
      } catch (e) {
        respond(id, { content: [{ type: 'text', text: '错误: ' + e.message }], isError: true });
      }
    } else if (method === 'ping') {
      respond(id, {});
    } else if (id !== undefined) {
      respond(id, null, { code: -32601, message: 'Method not found: ' + method });
    }
  } catch (e) {
    if (id !== undefined) respond(id, null, { code: -32603, message: e.message });
  }
});

rl.on('close', () => process.exit(0));

log('khyosMarkdown MCP 服务器已启动 (root: ' + ROOT + ')');
