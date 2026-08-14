'use strict';

/**
 * MeshPeer — 让一个运行中的 khy 实例发现同机其它 khy 实例、与之 attach/detach、跨进程互发消息。
 * 对齐 Claude Code 的多实例协作:多个独立会话彼此可见、可通信。
 *
 * 「我是谁」=当前会话 id(context.traceContext.sessionId);首次使用自动把本会话登记进网格。
 * 逻辑/校验/信封全部委派纯叶子 meshCore;磁盘在册表 + 跨进程信箱由薄 IO 层 meshStore 负责。
 * 与 coordinator/teammate(单进程内多 agent)、remote(跨机 SSH)正交 —— 这里是**同机多实例**。
 *
 * 安全:本工具只传递实例 id 与明文消息,绝不触碰密钥(密钥保险库由 vault 族独立管辖)。
 */

const { defineTool } = require('./_baseTool');

function _selfId(context) {
  const tc = context && context.traceContext;
  const sid = tc && (tc.sessionId || tc.traceId);
  const core = require('../services/meshCore');
  return core.normalizeId(sid) || null;
}

module.exports = defineTool({
  name: 'MeshPeer',
  description:
    'Collaborate with OTHER running khy instances on this machine (Claude Code-aligned multi-instance mesh). '
    + 'action="peers" lists live peer instances; "send" delivers a message to a peer (by id); '
    + '"inbox" drains messages addressed to you; "attach"/"detach" set or clear your default peer. '
    + 'Distinct from in-process teammates/coordinator and from cross-machine remote — this is same-machine, separate processes.',
  category: 'coordinator',
  risk: 'low',
  aliases: ['mesh', 'peer', 'peers', 'meshPeer'],
  isReadOnly: (params) => {
    const a = String((params && params.action) || 'peers').toLowerCase();
    return a === 'peers' || a === 'inbox';
  },
  isConcurrencySafe: true,
  inputSchema: {
    action: {
      type: 'string',
      required: false,
      enum: ['peers', 'send', 'inbox', 'attach', 'detach'],
      description: 'peers (default) | send | inbox | attach | detach.',
    },
    to: {
      type: 'string',
      required: false,
      description: 'Target peer instance id (for send/attach). If omitted on send, uses your attached peer.',
    },
    message: {
      type: 'string',
      required: false,
      description: 'Message text to deliver (for send).',
    },
    name: {
      type: 'string',
      required: false,
      description: 'Optional friendly name to register this instance under (shown to peers).',
    },
  },
  async execute(params, context) {
    const core = require('../services/meshCore');
    if (!core.isEnabled()) {
      return { success: false, error: 'Multi-instance mesh is disabled (KHY_MESH=off).' };
    }
    const store = require('../services/meshStore');

    const self = _selfId(context);
    if (!self) {
      return { success: false, error: 'Cannot resolve this instance id (no session id in context); mesh requires a running session.' };
    }
    // 首次使用即把本会话登记进网格(幂等;保留既有 startedAt/attachedTo)。
    const reg = store.register({ id: self, name: (params && params.name) || undefined });
    if (!reg.ok) return { success: false, error: `register failed: ${reg.error}` };

    const action = String((params && params.action) || 'peers').toLowerCase();

    try {
      if (action === 'peers') {
        const peers = store.listPeers({ selfId: self });
        return { success: true, data: { self, count: peers.length, summary: core.buildPeersSummary(peers), peers } };
      }

      if (action === 'inbox') {
        const res = store.drainInbox(self);
        const messages = res.messages || [];
        return {
          success: true,
          data: {
            self,
            count: messages.length,
            summary: messages.length ? `收到 ${messages.length} 条新消息。` : '信箱为空。',
            messages,
          },
        };
      }

      if (action === 'send') {
        let to = core.normalizeId(params && params.to);
        if (!to) {
          // 回落到 attached 默认对端
          const me = store.getPeer(self);
          to = me && core.normalizeId(me.attachedTo);
        }
        if (!to) return { success: false, error: 'No target: pass `to`, or attach to a peer first.' };
        const text = String((params && params.message) || '');
        const res = store.send(self, to, text);
        if (!res.ok) return { success: false, error: res.error };
        return { success: true, data: { self, to, summary: core.buildSendSummary(res) } };
      }

      if (action === 'attach') {
        const to = core.normalizeId(params && params.to);
        if (!to) return { success: false, error: '`to` (peer id) is required for attach.' };
        const res = store.attach(self, to);
        if (!res.ok) return { success: false, error: res.error };
        return { success: true, data: { self, attachedTo: to, summary: `已挂接到实例「${to}」,后续 send 默认发往它。` } };
      }

      if (action === 'detach') {
        const res = store.detach(self);
        if (!res.ok) return { success: false, error: res.error };
        return { success: true, data: { self, summary: '已解除挂接。' } };
      }

      return { success: false, error: `Unknown action「${action}」.` };
    } catch (err) {
      return { success: false, error: (err && err.message) || String(err) };
    }
  },
});
