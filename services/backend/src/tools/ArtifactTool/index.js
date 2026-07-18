const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../../utils/dataHome');
const leaf = require('../../services/artifact/artifactPlan');

/**
 * ArtifactTool — 把生成内容持久化为**本地工件**(create / list / read)。对齐 Claude Code 的 Artifact 工具
 * (把产出登记为可分享的云端工件并返回托管 URL),但**诚实落到 khy 的本地语义**:khy 无云端工件托管,绝不伪造
 * 托管 URL/上传,而是把内容原子写进 `getDataDir('artifacts')/<安全名>` 并返回**本地路径**,让产出跨调用可发现复用。
 *
 * **背后逻辑**(动作/参数校验 + 安全文件名派生防目录穿越 + 结果构造)在纯叶子 services/artifact/artifactPlan.js
 * (单一真源·零 IO);本工具壳只做:经既有 getDataDir 得落点 + 原子写(temp+rename)/ 列目录 / 读回 + 大小把关。
 * 绝不另起炉灶,绝不写死任何目录/host/token。
 *
 * 诚实边界:① 返回本地绝对路径,不是云 URL;② 文件名经叶子严格清洗,绝不目录穿越;③ 单文件 ≤1MB(同 ReviewArtifact)。
 */
class ArtifactTool extends BaseTool {
  static toolName = 'Artifact';
  static category = 'filesystem';
  static risk = 'safe';
  static aliases = ['artifact', 'save_artifact'];
  static searchHint = 'save persist artifact local store output reuse';
  static shouldDefer = true;

  // create 写文件(非只读);list/read 只读。destructive 永假(只新增/覆盖自管目录,不删他人文件)。
  isReadOnly(input) {
    const action = input && typeof input.action === 'string' ? input.action.toLowerCase() : 'create';
    return action === 'list' || action === 'read';
  }
  isDestructive() { return false; }
  isConcurrencySafe(input) { return this.isReadOnly(input); }

  prompt() {
    return `Persist generated content as a LOCAL artifact under the khy data dir, or list/read existing ones.
Honest local equivalent of a shareable artifact: returns a local path, NOT a cloud URL.
  action=create (default): save {content} as an artifact; optional {name},{kind} (kind picks an extension).
  action=list: list saved artifacts (name + bytes).
  action=read: read back a saved artifact by {name}.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'create | list | read', enum: ['create', 'list', 'read'], default: 'create' },
        content: { type: 'string', description: 'Artifact content (required for create)' },
        name: { type: 'string', description: 'Artifact name (required for read; optional for create)' },
        kind: { type: 'string', description: 'Content kind hint for file extension (js, py, json, html, md, …)' },
      },
      required: [],
    };
  }

  _dir() { return getDataDir('artifacts'); }

  async execute(params) {
    // 门控关 → 诚实回退「如同未装」:不写任何文件,返回禁用提示(逐字节稳定,绝不伪造成功)。
    if (!leaf.isEnabled(process.env)) {
      return leaf.buildErrorResult('Artifact 工具已被 KHY_ARTIFACT_TOOL 门控关闭。');
    }
    const v = leaf.validateInput(params);
    if (!v.ok) return leaf.buildErrorResult(v.error);

    try {
      if (v.action === 'list') return this._list();
      if (v.action === 'read') return this._read(params);
      return this._create(params);
    } catch (err) {
      return leaf.buildErrorResult((err && err.message) || err);
    }
  }

  _create(params) {
    const content = String(params.content);
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
      return leaf.buildErrorResult('内容过大(>1MB),拒绝保存为工件。');
    }
    // fallbackStem 含 pid + 内容长度 —— 缺 name 时也唯一,且叶子保持无时钟。
    const fallbackStem = `artifact-${process.pid}-${content.length}`;
    const safeName = leaf.deriveSafeName({ name: params.name, kind: params.kind, fallbackStem });
    const dir = this._dir();
    const file = path.join(dir, safeName);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    const bytes = Buffer.byteLength(content, 'utf8');
    return leaf.buildCreateResult({ name: safeName, path: file, bytes });
  }

  _list() {
    const dir = this._dir();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const entries = [];
    for (const name of names) {
      if (name.includes('.tmp-')) continue; // 跳过半成品临时文件
      let bytes = 0;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (!st.isFile()) continue;
        bytes = st.size;
      } catch { continue; }
      entries.push({ name, bytes });
    }
    return leaf.buildListResult(entries);
  }

  _read(params) {
    const safeName = leaf.deriveSafeName({ name: params.name });
    const dir = this._dir();
    const file = path.join(dir, safeName);
    if (!fs.existsSync(file)) {
      return leaf.buildErrorResult(`未找到工件:${safeName}(用 action=list 查看现有工件)`);
    }
    const st = fs.statSync(file);
    if (st.size > 1024 * 1024) return leaf.buildErrorResult('工件过大(>1MB),拒绝读回。');
    const content = fs.readFileSync(file, 'utf-8');
    return leaf.buildReadResult({ name: safeName, path: file, content });
  }

  getActivityDescription(input) { return leaf.describeActivity(input); }
}

module.exports = ArtifactTool;
