'use strict';

/**
 * contractDocGenerator.js — 契约文档生成器（§3.1 契约即文档：唯一真相源）。
 *
 * 「代码即唯一真相」：API/数据结构说明绝不另起独立文本，一律从源码的 JSDoc 契约注释
 * 确定性坍缩为 Markdown。开发者/简单模型只改契约注释，文档随之自动更新——杜绝双源不一致
 * （防呆①）。
 *
 * 解析策略：零依赖、纯函数。逐个抽取 `/** … *\/` 文档块及其紧随的声明签名
 * （function / class / const arrow / class method），从块中提炼描述、@param、@returns、@throws。
 * 这是结构层（非完整 AST 语义）解析，足以驱动 API 文档与测试骨架，且永不引入第三方依赖。
 *
 * 不做 I/O 的核心是 `extractContracts(source, moduleName)`；`renderMarkdown` 渲染；
 * `generateForFiles` 是 fs 薄封装（唯一触盘处）。
 */

const fs = require('fs');
const path = require('path');

const DOC_BLOCK = /\/\*\*([\s\S]*?)\*\//g;

// 声明签名识别（取文档块之后第一行有效代码）。
const SIG_PATTERNS = [
  { kind: 'function', re: /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/ },
  { kind: 'class', re: /^class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'const-fn', re: /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/ },
  { kind: 'const-fn', re: /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/ },
  { kind: 'method', re: /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/ },
];

const METHOD_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'class']);

class ContractDocGenerator {
  /**
   * 从源码抽取契约清单（纯函数）。
   * @param {string} source      JS 源码文本
   * @param {string} moduleName  模块名（用于文档标题）
   * @returns {{module:string, contracts:Array<{name,kind,signature,description,params,returns,throws}>}}
   */
  extractContracts(source, moduleName) {
    const src = String(source == null ? '' : source);
    const contracts = [];
    let m;
    DOC_BLOCK.lastIndex = 0;
    while ((m = DOC_BLOCK.exec(src)) !== null) {
      const body = this._parseDocBody(m[1]);
      const after = src.slice(m.index + m[0].length);
      const sig = this._firstSignature(after);
      if (!sig) continue;                       // 文件级/段落级注释无签名 → 跳过（非接口契约）
      contracts.push({
        name: sig.name,
        kind: sig.kind,
        signature: sig.signature,
        description: body.description,
        params: body.params,
        returns: body.returns,
        throws: body.throws,
      });
    }
    return { module: String(moduleName || 'module'), contracts };
  }

  /** 取一段代码里第一行有效声明的签名（跳过空行/注释行）。 */
  _firstSignature(text) {
    const lines = text.split('\n');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
      for (const { kind, re } of SIG_PATTERNS) {
        const mm = re.exec(line);
        if (mm) {
          if (kind === 'method' && METHOD_KEYWORDS.has(mm[1])) return null;
          // 签名止于声明头（去函数体/箭头/花括号），避免单行实现泄入签名。
          const signature = mm[0].replace(/\s*(=>|\{)\s*$/, '').trim();
          return { kind, name: mm[1], params: mm[2] || '', signature };
        }
      }
      return null;                              // 第一行有效代码不是声明 → 该块非接口契约
    }
    return null;
  }

  /** 解析 JSDoc 块体：描述 + @param/@returns/@throws。 */
  _parseDocBody(block) {
    const lines = String(block).split('\n').map((l) => l.replace(/^\s*\*?\s?/, ''));
    const descLines = [];
    const params = [];
    let returns = null;
    const throws = [];
    for (const line of lines) {
      const pm = /^@param\s+\{([^}]*)\}\s+(\[?[\w.$]+\]?)\s*(.*)$/.exec(line);
      if (pm) { params.push({ type: pm[1].trim(), name: pm[2].trim(), desc: pm[3].trim() }); continue; }
      const rm = /^@returns?\s+\{([^}]*)\}\s*(.*)$/.exec(line);
      if (rm) { returns = { type: rm[1].trim(), desc: rm[2].trim() }; continue; }
      const tm = /^@throws?\s+\{?([^}]*)\}?\s*(.*)$/.exec(line);
      if (tm) { throws.push({ type: tm[1].trim(), desc: tm[2].trim() }); continue; }
      if (/^@\w+/.test(line)) continue;         // 其它标签忽略
      if (line.trim()) descLines.push(line.trim());
    }
    return { description: descLines.join(' ').trim(), params, returns, throws };
  }

  /**
   * 渲染契约清单为 API Markdown（纯函数）。
   * @param {Array<{module, contracts}>} modules
   * @returns {string}
   */
  renderMarkdown(modules) {
    const out = ['# API 契约文档（自动生成 · 代码即唯一真相）', '',
      '> 本文件由 `ContractDocGenerator` 从源码 JSDoc 契约确定性生成，**请勿手工编辑**（防呆①）。', ''];
    for (const mod of modules) {
      out.push(`## ${mod.module}`, '');
      if (!mod.contracts.length) { out.push('_（无导出契约）_', ''); continue; }
      for (const c of mod.contracts) {
        out.push(`### \`${c.signature}\`  _(${c.kind})_`, '');
        if (c.description) out.push(c.description, '');
        if (c.params.length) {
          out.push('| 参数 | 类型 | 说明 |', '| --- | --- | --- |');
          for (const p of c.params) out.push(`| \`${p.name}\` | \`${p.type}\` | ${p.desc || ''} |`);
          out.push('');
        }
        if (c.returns) out.push(`**返回** \`${c.returns.type}\` — ${c.returns.desc || ''}`, '');
        if (c.throws.length) out.push(`**抛出** ${c.throws.map((t) => `\`${t.type}\``).join(', ')}`, '');
      }
    }
    return out.join('\n');
  }

  /**
   * 从一组文件生成 API Markdown（唯一触盘处）。
   * @param {string[]} files  绝对路径数组
   * @returns {string}
   */
  generateForFiles(files) {
    const modules = [];
    for (const f of files) {
      let source = '';
      try { source = fs.readFileSync(f, 'utf-8'); } catch { continue; }
      modules.push(this.extractContracts(source, path.basename(f)));
    }
    return this.renderMarkdown(modules);
  }
}

module.exports = { ContractDocGenerator };
