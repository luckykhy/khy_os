'use strict';

/**
 * instructionEcosystemRegistry.js 鈥?绾彾瀛?**銆宬hy 韫鍒?鎸囦护鐢熸€併€嶇殑鍗曚竴澹版槑寮忕湡婧?*銆? * 闆?IO / 纭畾鎬?/ 缁濅笉鎶涖€? *
 * ## 鑳屾櫙(goal 2026-08-18銆宬hyos 鐨勭敓鎬佷笉澶熷畬鍠?鎴戝笇鏈涗綘韫敓鎬併€嶇浜屽潡)
 *
 * 绗竴鍧?`services/mcp/mcpEcosystemRegistry`)韫殑鏄?*宸ュ叿灞?*(MCP server)銆傝繖涓€鍧楄弓鐨勬槸
 * **涓婁笅鏂囧眰**:姣忎釜浠撳簱銆佹瘡鍙板紑鍙戞満涓?鍒殑 agent 鏃╁氨鍐欏ソ浜嗐€岃繖涓」鐩鎬庝箞骞叉椿銆嶇殑瑙勫垯鏂囦欢銆? * 杩欐槸鍏ㄧ敓鎬侀噷**瀛橀噺鏈€澶?*鐨勮祫浜?鈥斺€?鐢ㄦ埛涓嶇敤涓?khy 鍐嶅啓涓€閬嶃€? *
 * 浣嗘帴鍏ュ墠 khy 鍙**涓ょ粍**鏉ユ簮:
 *   - `instructionFileService.discoverInstructionFiles()` 鈫?`~/.khyquant/khy.md` 路
 *     `<git-root>/khy.md` 路 `<git-root>/.khy/rules/*.md` 路 `<cwd>/khy.md`(khy 鑷繁鐨?
 *   - `constants/prompts.js` 鐨勬墜鍐欏吋瀹瑰潡 `_findCompatInstructionFiles()` 鈫? *     `CLAUDE.md` 路 `.claude/CLAUDE.md` 路 `AGENTS.md`(椤圭洰 + 涓荤洰褰?
 * 涔熷氨鏄:涓€涓啓濂戒簡 `.cursor/rules/*.mdc`銆乣.github/copilot-instructions.md`銆? * `.windsurf/rules/`銆乣.kiro/steering/` 鐨勪粨搴?鍦?khy 鐪奸噷**绛変簬娌℃湁瑙勫垯** 鈥斺€?鑰屼笖姣忔帴涓€瀹? * 閮借寰€ prompts.js 閲屽啀鎵嬪啓涓€娈点€? *
 * 鏈ā鍧楁妸銆屼竴瀹剁敓鎬佺殑瑙勫垯鏂囦欢鍦ㄥ摢銆嶅彉鎴?*涓€琛岃〃椤?*,澹抽噷鍙暀涓€涓€氱敤寰幆銆? *
 * ## 濂戠害
 * - 闆?IO:homedir / projectDir / env 鐢卞３娉ㄥ叆;鏂囦欢**鏂囨湰**涔熺敱澹宠鍏ュ悗浼犺繘鏉ャ€? * - 纭畾鎬?鍚岃緭鍏ュ悓杈撳嚭,琛ㄩ」椤哄簭鍗虫敞鍏ラ『搴忋€? * - 缁濅笉鎶?浠讳綍鍧忚緭鍏?鈫?瀹夊叏绌哄€?[] / null / false)銆? * - 闂ㄦ帶:鎬婚椄 `KHY_RULES_ECOSYSTEM`(榛樿寮€)+ 姣忓 `KHY_RULES_ECO_<ID>`(榛樿寮€,鐖朵负鎬婚椄)銆? *   鎬婚椄鍏?鈫?`instructionEcosystemSources()` 杩?`[]`,澹抽噷寰幆鏁翠綋绌鸿浆,
 *   `discoverInstructionFiles` 鐨勮繑鍥炲€间笌鎺ュ叆鍓?*閫愬瓧鑺傜浉鍚?*銆? *
 * ## 涓轰粈涔堜笉鏄€屾棤鑴戝叏濉炶繘鍘汇€? * 瑙勫垯鏂囦欢鏄?*绗笁鏂规枃鏈?*,鐩存帴杩涚郴缁熸彁绀鸿瘝鏈変袱涓湡瀹為闄?鏈ā鍧楀悇缁欎簡涓€鎶婇椄:
 *   1. **鎻愮ず璇嶆敞鍏?* 鈥斺€?澹冲鐢?`instructionFileService.scanForPromptInjection`(鐢熸€佹枃浠朵笌
 *      khy 鑷繁鐨勬枃浠惰蛋**鍚屼竴鏉?*鎵弿/鑴辨晱璺緞,涓嶅紑鍚庨棬)銆? *   2. **棰勭畻鎸ゅ崰** 鈥斺€?鐢熸€佸眰鏈夌嫭绔嬬殑 `ECO_MAX_FILE_CHARS` / `ECO_MAX_TOTAL_CHARS` 涓婇檺,
 *      涓旀帓鍦?khy 鑷繁鐨勬寚浠?*涔嬪悗**;鍒汉鐨勮鍒欐案杩滄尋涓嶆帀浣犺嚜宸辩殑銆? * 鍙﹀,`.cursor/rules/*.mdc` 涓?`.github/instructions/*.instructions.md` 鏄?*甯︿綔鐢ㄥ煙**鐨?
 * 鍙湁 `alwaysApply: true` / `applyTo: '**'` 鐨勬墠鏄€屾案杩滅敓鏁堛€嶃€傜収鎶勫叏閮ㄤ細鎶婁竴鍫? * 璺緞闄愬畾瑙勫垯鐏岃繘姣忎竴杞璇?鈥斺€?`isAlwaysOnRule()` 灏辨槸杩欓亾杩囨护(瑙佸叾鏂囨。)銆? *
 * ## 璇氬疄杈圭晫(鍔″繀淇濈暀鍦ㄦ枃妗ｉ噷)
 * - 鏈ā鍧楀彧**鍙戠幇骞跺鐢?*纾佺洏涓婂凡缁忓瓨鍦ㄧ殑瑙勫垯鏂囦欢;涓嶅畨瑁呫€佷笉鑱旂綉銆佷笉鍐欏叆銆佷笉鏀瑰埆瀹堕厤缃€? * - khy **涓嶅啓** `AGENTS.md`/`CLAUDE.md`/`.cursor/rules`(鍐欏叆鐩爣浠嶆槸 khy.md / agent.md,
 *   瑙?instructionFileService 鐨?`_resolveInstructionTarget`)鈥斺€?鍙涓嶅啓,涓嶆姠鍒汉鐨勬枃浠躲€? * - `CLAUDE.md` / `.claude/CLAUDE.md` / `AGENTS.md`(椤圭洰鏍?+ 涓荤洰褰?**鍒绘剰涓嶅湪鏈〃**:
 *   `constants/prompts.js` 鐨?`_findCompatInstructionFiles()` 宸茬粡鍦ㄦ敞鍏ュ畠浠?骞朵笖甯︿竴濂楁湰琛? *   娌℃湁鐨勮瑷€鎸囦护娑堣В閫昏緫(`_stripCompatLanguageSections`)銆傞噸澶嶇櫥璁?= 鍚屼竴浠借鍒欒繘涓ら亶鎻愮ず璇? *   涓旀墦涔辨棦瀹氱殑 KHY > CLAUDE > AGENTS 浼樺厛绾?瑙?tests/projectInstructions.precedence)銆? *   鈥斺€?涓?mcpEcosystemRegistry 鎶?claude-code / openclaw 璁╃粰涓撶敤妗?鏄悓涓€鏉¤鐭┿€? * - 姣忎釜琛ㄩ」甯?`evidence`:`'local'` = 鏈満/鏈粨纭瘉瀛樺湪;`'doc'` = 渚濇嵁涓婃父鏂囨。/绀惧尯绾﹀畾鐧昏銆? *   2026-08-18 瀹炴祴鏈満鍙湁 `~/.claude/`(绌虹洰褰?涓?`<repo>/AGENTS.md`,鏁呮湰琛ㄥ叏閮ㄤ负 `'doc'`銆? *   `'doc'` 椤硅矾寰勬湭缁忔湰鏈洪獙璇?浣嗚鍙栨槸 fail-soft 鐨?鈥斺€?鍐欓敊鐨勫悗鏋滄槸銆屾病韫埌銆?涓嶄細璇激銆? *
 * @module services/instructionEcosystemRegistry
 */

const _join = require('../utils/pathJoinSafe');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 鐢熸€佸眰鐙珛棰勭畻:鍗曟枃浠朵笂闄?/ 鏈眰鎬讳笂闄?澹宠礋璐ｆ墽琛?銆?*/
const ECO_MAX_FILE_CHARS = 4000;
const ECO_MAX_TOTAL_CHARS = 8000;
/** 鍗曚釜鐩綍鍨?source 鏈€澶氶噰绾崇殑鏂囦欢鏁?闃叉 .cursor/rules 閲?50 鏉¤鍒欑偢棰勭畻)銆?*/
const ECO_MAX_FILES_PER_DIR = 12;

/**
 * 澹版槑寮忕敓鎬佽〃銆?*鏂板涓€瀹剁敓鎬?= 鍦ㄨ繖閲屽姞涓€琛?*,澹充笉鍔ㄣ€? *
 *   id        鈥?绋冲畾鐭?id(涔熸槸 `ecosystem` 鏍囪鍊间笌 CLI 灞曠ず key)
 *   label     鈥?浜鸿鍚嶅瓧(杩涙敞鍏ュご `[鐢熸€佹寚浠?Cursor) - <path>]`)
 *   gate      鈥?璇ュ鐨?env 闂ㄦ帶鍚?榛樿寮€;鐖堕棬鎺?KHY_RULES_ECOSYSTEM)
 *   evidence  鈥?'local'(鏈満/鏈粨纭瘉)| 'doc'(涓婃父鏂囨。绾﹀畾)
 *   sources[] 鈥?瑙勫垯鏂囦欢浣嶇疆:
 *                 base  'home' = 鐢ㄦ埛涓荤洰褰?| 'project' = 椤圭洰鏍?git-root,澹虫敞鍏?
 *                 segs  鐩稿璇?base 鐨勮矾寰勬
 *                 mode  'file' = segs 灏辨槸鏂囦欢 | 'dir' = segs 鏄洰褰?澹虫寜 exts 鎵弿
 *                 exts  浠?mode='dir' 鏈夋晥:閲囩撼鐨勬墿灞曞悕(灏忓啓,鍚偣),鎸夋枃浠跺悕鎺掑簭
 *                 kind  璇?source 鐨勭ǔ瀹氭爣璇?杩涜瘖鏂緭鍑?
 *                 scoped 璇?source 鐨勬枃浠跺甫浣滅敤鍩熷墠瑷€,闇€杩?isAlwaysOnRule()
 */
const ECOSYSTEMS = Object.freeze(
  [
    {
      // Codex 鐢ㄧ殑鏄法鍘傚晢鏍囧噯 AGENTS.md;椤圭洰鏍归偅浠藉凡鐢?prompts.js 鐨勫吋瀹瑰潡鎺ョ(瑙?EXCLUDED),
      // 杩欓噷鍙ˉ瀹?*娌¤鐩?*鐨勭敤鎴风骇閭ｄ唤 鈥斺€?鐢ㄦ埛鍐欑粰鎵€鏈変粨搴撶殑閫氱敤绾﹀畾銆?      id: 'codex',
      label: 'Codex CLI (~/.codex/AGENTS.md)',
      gate: 'KHY_RULES_ECO_CODEX',
      evidence: 'doc',
      sources: [{ base: 'home', segs: ['.codex', 'AGENTS.md'], mode: 'file', kind: 'user' }],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      gate: 'KHY_RULES_ECO_CURSOR',
      evidence: 'doc',
      sources: [
        // .mdc files carry frontmatter (description / globs / alwaysApply) and are scope-filtered.
        {
          base: 'project',
          segs: ['.cursor', 'rules'],
          mode: 'dir',
          exts: ['.mdc', '.md'],
          kind: 'rules',
          scoped: true,
        },
        // Legacy single-file convention: no frontmatter, always on.
        { base: 'project', segs: ['.cursorrules'], mode: 'file', kind: 'legacy' },
      ],
    },
    {
      id: 'copilot',
      label: 'GitHub Copilot',
      gate: 'KHY_RULES_ECO_COPILOT',
      evidence: 'doc',
      sources: [
        {
          base: 'project',
          segs: ['.github', 'copilot-instructions.md'],
          mode: 'file',
          kind: 'repo',
        },
        // *.instructions.md uses an applyTo glob to limit scope; filter those rules.
        {
          base: 'project',
          segs: ['.github', 'instructions'],
          mode: 'dir',
          exts: ['.md'],
          kind: 'instructions',
          scoped: true,
        },
      ],
    },
    {
      id: 'windsurf',
      label: 'Windsurf (Codeium)',
      gate: 'KHY_RULES_ECO_WINDSURF',
      evidence: 'doc',
      sources: [
        {
          base: 'project',
          segs: ['.windsurf', 'rules'],
          mode: 'dir',
          exts: ['.md'],
          kind: 'rules',
          scoped: true,
        },
        { base: 'project', segs: ['.windsurfrules'], mode: 'file', kind: 'legacy' },
        { base: 'home', segs: ['.codeium', 'windsurf', 'memories', 'global_rules.md'], mode: 'file', kind: 'user' },
      ],
    },
    {
      id: 'cline',
      label: 'Cline',
      gate: 'KHY_RULES_ECO_CLINE',
      evidence: 'doc',
      sources: [
        // .clinerules may be either a file or a directory; register both forms.
        { base: 'project', segs: ['.clinerules'], mode: 'file', kind: 'file' },
        { base: 'project', segs: ['.clinerules'], mode: 'dir', exts: ['.md'], kind: 'dir' },
      ],
    },
    {
      id: 'roo',
      label: 'Roo Code',
      gate: 'KHY_RULES_ECO_ROO',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['.roo', 'rules'], mode: 'dir', exts: ['.md'], kind: 'rules' },
        { base: 'project', segs: ['.roorules'], mode: 'file', kind: 'legacy' },
      ],
    },
    {
      id: 'gemini',
      label: 'Gemini CLI',
      gate: 'KHY_RULES_ECO_GEMINI',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['GEMINI.md'], mode: 'file', kind: 'project' },
        { base: 'home', segs: ['.gemini', 'GEMINI.md'], mode: 'file', kind: 'user' },
      ],
    },
    {
      id: 'qwen',
      label: 'Qwen Code',
      gate: 'KHY_RULES_ECO_QWEN',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['QWEN.md'], mode: 'file', kind: 'project' },
        { base: 'home', segs: ['.qwen', 'QWEN.md'], mode: 'file', kind: 'user' },
      ],
    },
    {
      id: 'kiro',
      label: 'AWS Kiro',
      gate: 'KHY_RULES_ECO_KIRO',
      evidence: 'doc',
      sources: [
        {
          base: 'project',
          segs: ['.kiro', 'steering'],
          mode: 'dir',
          exts: ['.md'],
          kind: 'steering',
          scoped: true,
        },
      ],
    },
    {
      id: 'amazonq',
      label: 'Amazon Q Developer',
      gate: 'KHY_RULES_ECO_AMAZONQ',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['.amazonq', 'rules'], mode: 'dir', exts: ['.md'], kind: 'rules' },
      ],
    },
    {
      id: 'continue',
      label: 'Continue',
      gate: 'KHY_RULES_ECO_CONTINUE',
      evidence: 'doc',
      sources: [
        {
          base: 'project',
          segs: ['.continue', 'rules'],
          mode: 'dir',
          exts: ['.md'],
          kind: 'rules',
          scoped: true,
        },
      ],
    },
    {
      id: 'junie',
      label: 'JetBrains Junie',
      gate: 'KHY_RULES_ECO_JUNIE',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['.junie', 'guidelines.md'], mode: 'file', kind: 'guidelines' },
      ],
    },
    {
      id: 'trae',
      label: 'Trae',
      gate: 'KHY_RULES_ECO_TRAE',
      evidence: 'doc',
      sources: [
        { base: 'project', segs: ['.trae', 'rules', 'project_rules.md'], mode: 'file', kind: 'project' },
      ],
    },
    {
      id: 'zed',
      label: 'Zed / opencode (.rules)',
      gate: 'KHY_RULES_ECO_ZED',
      evidence: 'doc',
      sources: [{ base: 'project', segs: ['.rules'], mode: 'file', kind: 'project' }],
    },
    {
      id: 'aider',
      label: 'Aider (CONVENTIONS.md)',
      gate: 'KHY_RULES_ECO_AIDER',
      evidence: 'doc',
      sources: [{ base: 'project', segs: ['CONVENTIONS.md'], mode: 'file', kind: 'conventions' }],
    },
    {
      id: 'firebase-studio',
      label: 'Firebase Studio (IDX)',
      gate: 'KHY_RULES_ECO_FIREBASE_STUDIO',
      evidence: 'doc',
      sources: [{ base: 'project', segs: ['.idx', 'airules.md'], mode: 'file', kind: 'airules' }],
    },
  ].map((e) =>
    Object.freeze({ ...e, sources: Object.freeze(e.sources.map((s) => Object.freeze(s))) })
  )
);

/** Sources deliberately excluded to avoid duplicate bridges. */
const EXCLUDED = Object.freeze({
  khy: 'khy.md / KHY.md / .khy/rules are handled by khy native discovery',
  'agent-md-singular': 'agent.md / AGENT.md are khy write targets, not foreign assets',
  'claude-md':
    'CLAUDE.md / .claude/CLAUDE.md are injected by prompts.js compat discovery with precedence handling',
  'agents-md-root':
    '<project>/AGENTS.md and ~/AGENTS.md are handled by prompts.js; only ~/.codex/AGENTS.md is added here',
  'github-prompts': 'GitHub prompt files are on-demand commands, not resident rules',
  'claude-commands': 'Claude commands are handled by ccCommandBridge',
  'claude-skills': 'Claude skills are handled by ccSkillBridge',
  warp: 'Warp rules are stored in an application database, not readable rule files',
});

// 鈹€鈹€ 闂ㄦ帶 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** 鎬婚椄 KHY_RULES_ECOSYSTEM:榛樿寮€,{0,false,off,no} 鍏炽€備紭鍏堣蛋 flagRegistry銆?*/
function isInstructionEcosystemEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_RULES_ECOSYSTEM', e);
    }
  } catch {
    /* 娉ㄥ唽琛ㄤ笉鍙敤 鈫?鏈湴鍏滃簳 */
  }
  const raw = e.KHY_RULES_ECOSYSTEM;
  return !(raw !== undefined && raw !== null && _FALSY.has(String(raw).trim().toLowerCase()));
}

/** 鏌愬鐢熸€佹槸鍚﹀惎鐢?鎬婚椄寮€ 涓?鑷韩闂ㄦ帶鏈鏄惧紡鍏抽棴銆傛湭鐭?id 鈫?false銆?*/
function isEcosystemEnabled(id, env = process.env) {
  try {
    if (!isInstructionEcosystemEnabled(env)) {
      return false;
    }
    const eco = ECOSYSTEMS.find((x) => x.id === String(id || '').trim());
    if (!eco) {
      return false;
    }
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (
        reg &&
        typeof reg.isRegistryEnabled === 'function' &&
        reg.isRegistryEnabled(e) &&
        typeof reg.isFlagEnabled === 'function'
      ) {
        return reg.isFlagEnabled(eco.gate, e);
      }
    } catch {
      /* 鍏滃簳 */
    }
    const raw = e[eco.gate];
    return !(raw !== undefined && raw !== null && _FALSY.has(String(raw).trim().toLowerCase()));
  } catch {
    return false;
  }
}

/** 褰撳墠鍚敤鐨勭敓鎬佽〃椤?鎬婚椄鍏?鈫?[])銆?*/
function getEcosystems(env = process.env) {
  try {
    if (!isInstructionEcosystemEnabled(env)) {
      return [];
    }
    return ECOSYSTEMS.filter((e) => isEcosystemEnabled(e.id, env));
  } catch {
    return [];
  }
}

// 鈹€鈹€ 璺緞瑙ｆ瀽 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/** 鎶婁竴涓?source 鐨?base 瑙ｆ瀽鎴愮粷瀵圭洰褰?涓嶅彲瑙ｆ瀽 鈫?''銆?*/
function resolveBase(base, { homedir, projectDir } = {}) {
  switch (base) {
    case 'home':
      return homedir ? String(homedir) : '';
    case 'project':
      return projectDir ? String(projectDir) : '';
    default:
      return '';
  }
}

/**
 * 鏋氫妇鎵€鏈夊惎鐢ㄧ敓鎬佺殑瑙勫垯鏂囦欢浣嶇疆(**涓嶇鏂囦欢绯荤粺** 鈥斺€?澹冲喅瀹氬摢浜涘瓨鍦ㄣ€佽鏂囨湰)銆? *
 * @param {object} args
 * @param {string} [args.homedir]    鐢ㄦ埛涓荤洰褰?澹虫敞鍏?os.homedir())
 * @param {string} [args.projectDir] 椤圭洰鏍?澹虫敞鍏?git-root || cwd)
 * @param {object} [args.env]        process.env
 * @returns {Array<{ecosystem:string,label:string,path:string,kind:string,mode:'file'|'dir',
 *                  exts:string[],scoped:boolean,evidence:string,maxFiles:number}>}
 *   琛ㄩ」椤哄簭 鈫?姣忛」鍐?source 椤哄簭(鍗虫敞鍏ラ『搴?銆傚潖杈撳叆/鎬婚椄鍏?鈫?[]銆? */
function instructionEcosystemSources({ homedir, projectDir, env = process.env } = {}) {
  try {
    const out = [];
    const seen = new Set();
    for (const eco of getEcosystems(env)) {
      for (const src of eco.sources) {
        const base = resolveBase(src.base, { homedir, projectDir });
        if (!base) {
          continue;
        }
        const full = _join(base, ...src.segs);
        if (!full) {
          continue;
        }
        // The same path can appear under two sources; include mode in the dedup key.
        const key = `${full} ${src.mode}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.push({
          ecosystem: eco.id,
          label: eco.label,
          path: full,
          kind: src.kind,
          mode: src.mode === 'dir' ? 'dir' : 'file',
          exts: Array.isArray(src.exts) ? src.exts.slice() : ['.md'],
          scoped: src.scoped === true,
          evidence: eco.evidence,
          maxFiles: ECO_MAX_FILES_PER_DIR,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// 鈹€鈹€ 浣滅敤鍩熻繃婊?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * 瑙ｆ瀽瑙勫垯鏂囦欢鐨?YAML frontmatter(**鍙鏈ā鍧楀叧蹇冪殑鍑犱釜閿?*,涓嶆槸閫氱敤 YAML 瑙ｆ瀽鍣?銆? * 鏃?frontmatter / 鍧忚緭鍏?鈫?`{}`銆傜粷涓嶆姏銆? *
 * 璁ゅ緱鐨勯敭:`alwaysApply`(Cursor .mdc)銆乣applyTo`(Copilot .instructions.md)銆? * `globs`(Cursor)銆乣inclusion`(Kiro steering:always | fileMatch | manual)銆? * `description`(灞曠ず鐢?銆? *
 * @param {string} text 鏂囦欢鍏ㄦ枃
 * @returns {{alwaysApply?:boolean, applyTo?:string, globs?:string, inclusion?:string, description?:string}}
 */
function parseRuleFrontmatter(text) {
  try {
    if (typeof text !== 'string' || !text) {
      return {};
    }
    // Frontmatter must start at the beginning, allowing a BOM and blank lines.
    const m = /^﻿?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m) {
      return {};
    }
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) {
        continue;
      }
      const key = kv[1];
      let val = kv[2].trim();
      // Strip paired quotes from simple frontmatter scalar values.
      if (
        val.length >= 2 &&
        ((val[0] === '"' && val[val.length - 1] === '"') ||
          (val[0] === "'" && val[val.length - 1] === "'"))
      ) {
        val = val.slice(1, -1);
      }
      switch (key) {
        case 'alwaysApply':
          out.alwaysApply = /^(true|yes|1)$/i.test(val);
          break;
        case 'applyTo':
        case 'globs':
        case 'inclusion':
        case 'description':
          out[key] = val;
          break;
        default:
          break;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** 銆岀瓑浜庡叏浠撱€嶇殑 glob:杩欎簺鍐欐硶鎰忓懗鐫€瑙勫垯瀵规墍鏈夋枃浠剁敓鏁堛€?*/
const _UNIVERSAL_GLOB = new Set(['**', '**/*', '*', '**/**', '.', './**']);

/**
 * 杩欐潯瑙勫垯鏄惁銆屽父椹荤敓鏁堛€嶁€斺€斿嵆鍊煎緱杩?khy 鐨勭郴缁熸彁绀鸿瘝銆? *
 * khy 鐨勬彁绀鸿瘝缁勮**娌℃湁** per-file 浣滅敤鍩熸蹇?鎻愮ず璇嶆槸鏁磋疆瀵硅瘽鍏辩敤鐨?涓嶉殢褰撳墠缂栬緫鐨勬枃浠? * 鍙樺寲銆傛墍浠ヨ矾寰勯檺瀹氱殑瑙勫垯(Cursor `globs: "*.tsx"`銆丆opilot `applyTo: "src/**"`銆? * Kiro `inclusion: fileMatch`)濡傛灉鐓у崟鍏ㄦ敹,浼氬湪**姣忎竴杞?*娉ㄥ叆涓€鍫嗗綋鍓嶆牴鏈敤涓嶄笂鐨勭害鏉?鈥斺€? * 杩欎笉鏄€岃弓鍒颁簡鐢熸€併€?鏄線涓婁笅鏂囬噷鐏屽櫔闊炽€傛晠鍙噰绾虫槑纭叏灞€鐢熸晥鐨勯偅浜涖€? *
 * 鍒ゅ畾(鐭矾椤哄簭鍗充紭鍏堢骇):
 *   1. `alwaysApply` 鏄惧紡缁欎簡 鈫?鐩存帴鍚畠(true 鏀?/ false 寮?銆? *   2. `inclusion` 缁欎簡 鈫?鍙湁 `always` 鏀?Kiro 璇箟)銆? *   3. `applyTo` / `globs` 缁欎簡 鈫?鍙湁閫氶厤鍏ㄤ粨鐨勫啓娉曟敹銆? *   4. 閮芥病鏈?鈫?鏀?鏃?frontmatter 鐨勮鍒欐枃浠舵湰鏉ュ氨鏄叏灞€鐨?銆? *
 * 闈?scoped 鐨?source(濡?`.cursorrules`銆乣AGENTS.md`)涓嶇粡杩囨湰鍑芥暟,澹崇洿鎺ユ敹銆? *
 * @param {object} meta parseRuleFrontmatter 鐨勭粨鏋? * @returns {boolean}
 */
function isAlwaysOnRule(meta) {
  try {
    const m = meta && typeof meta === 'object' ? meta : {};
    if (typeof m.alwaysApply === 'boolean') {
      return m.alwaysApply;
    }
    if (typeof m.inclusion === 'string' && m.inclusion) {
      return m.inclusion.trim().toLowerCase() === 'always';
    }
    for (const key of ['applyTo', 'globs']) {
      const raw = m[key];
      if (typeof raw === 'string' && raw.trim()) {
        // 閫楀彿鍒嗛殧鐨勫 glob:浠讳竴绛変簬鍏ㄤ粨鍗宠涓哄叏灞€銆?        const parts = raw
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        return parts.some((p) => _UNIVERSAL_GLOB.has(p));
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 涓€姝ュ埌浣嶇殑閲囩撼鍒ゅ畾:缁?scoped source 鐨勬枃浠舵枃鏈?杩斿洖鏄惁鏀?+ 瑙ｆ瀽鍑虹殑鍏冧俊鎭€? * 闈?scoped source 璇风洿鎺ユ敹(澹抽噷 `src.scoped` 涓?false 鏃朵笉璋冩湰鍑芥暟)銆? *
 * @param {string} text
 * @returns {{accept:boolean, meta:object}}
 */
function evaluateScopedRule(text) {
  const meta = parseRuleFrontmatter(text);
  return { accept: isAlwaysOnRule(meta), meta };
}

module.exports = {
  ECOSYSTEMS,
  EXCLUDED,
  ECO_MAX_FILE_CHARS,
  ECO_MAX_TOTAL_CHARS,
  ECO_MAX_FILES_PER_DIR,
  isInstructionEcosystemEnabled,
  isEcosystemEnabled,
  getEcosystems,
  resolveBase,
  instructionEcosystemSources,
  parseRuleFrontmatter,
  isAlwaysOnRule,
  evaluateScopedRule,
};
