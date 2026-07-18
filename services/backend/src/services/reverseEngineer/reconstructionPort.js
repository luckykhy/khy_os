'use strict';

/**
 * reconstructionPort.js — 证据→结构化重建 (DESIGN-ARCH-054 §3.6)。
 *
 * 这是「AI 逆向」真正发生的地方：把前面各层采集的**确定性证据**（格式/架构/字符串/工具链
 * 指纹/反汇编/还原出的源码清单）打成证据包，交注入式 brain（模型）推断出软件的高层结构：
 * 推断语言与工具链、模块/函数地图、重建的伪源码骨架、置信度。
 *
 * 三条铁律：
 *   - brain 注入式（与 evoEngine.codeGenerator / dualTrackForge 同构）：无模型也能跑，退化为
 *     「纯证据报告」，可确定性单测（防呆③）。
 *   - 超时 race：模型不挂死整条流水线。
 *   - 证据 ≠ 推断：返回结构里 evidence 与 inference 两区严格分离，模型产出一律落进 inference
 *     并标 confidence；绝不把模型猜测混入确定性证据冒充事实（防呆①：不伪造、不张冠李戴）。
 */

const { extractFirstJson } = require('../gateway/safeJsonParse');

const DEFAULT_TIMEOUT_MS = parseInt(process.env.KHY_RE_BRAIN_TIMEOUT_MS, 10) || 30000;

const SYSTEM_PROMPT = `You are a software reverse-engineering analyst. You are given STRUCTURED EVIDENCE extracted from a compiled artifact (format, architecture, harvested strings, toolchain fingerprints, disassembly/decompiler output, and any recovered source listing).

Infer the software's high-level structure. Ground EVERY claim in the provided evidence — if evidence is thin, say so and lower confidence. Do NOT invent file names, functions, or APIs that the evidence does not support.

Output ONLY a JSON object:
{
  "inferredLanguage": "string (e.g. 'C++', 'Go', 'Python/PyInstaller', 'unknown')",
  "inferredToolchain": "string",
  "purposeSummary": "1-3 sentence guess at what the program does",
  "modules": [{"name": "string", "role": "string", "evidenceRef": "what evidence supports this"}],
  "entryPoints": ["string"],
  "reconstructedSkeleton": "pseudo-source or structural outline grounded in evidence (may be partial)",
  "dependencies": ["string"],
  "confidence": 0.0,
  "caveats": ["what could not be determined and why"]
}
Confidence is 0..1. Output ONLY the JSON object, no prose.`;

/** 把各层结果压成「给模型看的紧凑证据包」，控制 token 体量。 */
function buildEvidencePack(parts = {}) {
  const { scan = {}, strings = {}, recover = {}, orchestration = {} } = parts;
  const disasmSnippets = (orchestration.evidence || [])
    .filter((e) => e.ok && e.output)
    .map((e) => ({ tool: e.tool, kind: e.kind, sample: String(e.output).slice(0, 6000) }));

  return {
    format: scan.format,
    family: scan.family,
    recoverability: scan.recoverability,
    arch: scan.arch || {},
    sizeBytes: scan.sizeBytes,
    sha256: scan.sha256,
    markers: scan.markers || [],
    toolchainFingerprints: strings.toolchains || [],
    classifiedStrings: {
      urls: (strings.classified?.url || []).slice(0, 15).map((s) => s.text),
      paths: (strings.classified?.path || []).slice(0, 20).map((s) => s.text),
      versions: (strings.classified?.version || []).slice(0, 15).map((s) => s.text),
    },
    sampleStrings: (strings.samples || []).slice(0, 30).map((s) => s.text),
    recoveredMembers: (recover.members || []).slice(0, 80).map((m) => ({ name: m.name, kind: m.kind, size: m.size })),
    recoveredSourceCount: (recover.members || []).filter((m) => m.kind === 'source').length,
    disasm: disasmSnippets,
  };
}

/** 无模型时的确定性「证据报告」：不臆造结构，只如实归纳已知事实。 */
function _deterministicReport(pack) {
  const langGuess = _inferLanguageDeterministic(pack);
  return {
    source: 'evidence-only',
    inferredLanguage: langGuess.language,
    inferredToolchain: langGuess.toolchain,
    purposeSummary: '未启用模型推断：以下仅为确定性证据归纳，未做高层重建。',
    modules: [],
    entryPoints: [],
    reconstructedSkeleton: '',
    dependencies: [],
    confidence: langGuess.confidence,
    caveats: [
      'No model attached: structural reconstruction skipped.',
      pack.recoverability === 'native'
        ? 'Native binary: enable an external disassembler/decompiler and/or a model for deeper recovery.'
        : 'Source/bytecode recoverable: inspect recoveredMembers directly.',
    ],
  };
}

/** 纯证据的语言推断（工具链指纹 + 格式家族），保守给低置信度。 */
function _inferLanguageDeterministic(pack) {
  const fp = new Set(pack.toolchainFingerprints || []);
  const order = [
    ['go', 'Go', 'go toolchain'],
    ['rustc', 'Rust', 'rustc'],
    ['dotnet', 'C#/.NET', '.NET'],
    ['python', 'Python', pack.markers?.includes('pyinstaller') ? 'PyInstaller' : 'CPython'],
    ['node', 'JavaScript/Node', pack.markers?.includes('node-sea') ? 'Node SEA/pkg' : 'Node.js'],
    ['msvc', 'C/C++', 'MSVC'],
    ['gcc', 'C/C++', 'GCC'],
    ['clang', 'C/C++', 'Clang'],
    ['electron', 'JavaScript/Electron', 'Electron'],
  ];
  for (const [id, lang, tc] of order) {
    if (fp.has(id)) return { language: lang, toolchain: tc, confidence: 0.5 };
  }
  const FAMILY_LANG = { java: ['Java/JVM', 'JVM'], wasm: ['WebAssembly', 'wasm'], dotnet: ['C#/.NET', '.NET'] };
  if (FAMILY_LANG[pack.family]) return { language: FAMILY_LANG[pack.family][0], toolchain: FAMILY_LANG[pack.family][1], confidence: 0.4 };
  return { language: 'unknown', toolchain: 'unknown', confidence: 0.1 };
}

const _withTimeout = require('../../utils/withTimeout');

/**
 * 主入口：用证据包做结构化重建。
 * @param {object} pack       buildEvidencePack 的结果
 * @param {object} [deps]     { brain:(prompt)=>Promise<string|object>, timeoutMs }
 * @returns {Promise<object>} { source:'model'|'evidence-only', ...reconstruction }
 */
async function reconstruct(pack, deps = {}) {
  const brain = typeof deps.brain === 'function' ? deps.brain : null;
  if (!brain) return _deterministicReport(pack);

  const prompt = `${SYSTEM_PROMPT}\n\nEVIDENCE:\n${JSON.stringify(pack, null, 2)}`;
  const raw = await _withTimeout(Promise.resolve().then(() => brain(prompt)), deps.timeoutMs || DEFAULT_TIMEOUT_MS);

  if (!raw || raw.__timeout || raw.__error) {
    const fallback = _deterministicReport(pack);
    fallback.caveats.unshift(raw && raw.__timeout ? 'Model timed out; fell back to evidence-only.' : 'Model failed; fell back to evidence-only.');
    return fallback;
  }

  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const parsed = extractFirstJson(text, null);
  if (!parsed || typeof parsed !== 'object') {
    const fallback = _deterministicReport(pack);
    fallback.caveats.unshift('Model output was not valid JSON; fell back to evidence-only.');
    return fallback;
  }

  // 归一化 + 钳制 confidence；模型产出统一标 source='model'，与证据区分离。
  return {
    source: 'model',
    inferredLanguage: String(parsed.inferredLanguage || 'unknown'),
    inferredToolchain: String(parsed.inferredToolchain || 'unknown'),
    purposeSummary: String(parsed.purposeSummary || ''),
    modules: Array.isArray(parsed.modules) ? parsed.modules.slice(0, 100) : [],
    entryPoints: Array.isArray(parsed.entryPoints) ? parsed.entryPoints.slice(0, 50) : [],
    reconstructedSkeleton: String(parsed.reconstructedSkeleton || '').slice(0, 64 * 1024),
    dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.slice(0, 200) : [],
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    caveats: Array.isArray(parsed.caveats) ? parsed.caveats.slice(0, 30) : [],
  };
}

module.exports = {
  reconstruct,
  buildEvidencePack,
  _deterministicReport,
  _inferLanguageDeterministic,
  SYSTEM_PROMPT,
};
