'use strict';

/**
 * verificationLedger.js — 还原结构 vs khy 构建清单比对 (DESIGN-ARCH-054 §3.7)。
 *
 * 这一层闭合用户的核心诉求：「khy 生成的软件也可以由 khy 更好地验证」。
 *
 * 思路：khy 构建一个产物时，可顺手记录一份**构建清单**（源文件列表 + 各自 sha256 + 入口 +
 * 工具链 + 输出产物 sha256）。事后只剩 exe/打包产物时，逆向流水线还原出结构，再与清单比对，
 * 得出**保真度评分**与差异：哪些源文件被还原命中、哪些缺失、产物哈希是否与清单登记一致。
 *
 * 无清单时本层不阻断——退化为「无基线，仅给还原快照」，诚实标注无法做保真度判定。
 * 纯确定性、零模型、零副作用（除显式 writeManifest）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 构建清单 schema 版本（结构演进时单调升级）。 */
const MANIFEST_VERSION = 1;
/** 清单约定文件名（与产物同目录 / 指定路径）。 */
const MANIFEST_BASENAME = '.khy-build-manifest.json';

function _sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 生成构建清单（khy 构建产物后调用，便于将来自验）。纯数据，不强制落盘。
 * @param {object} spec
 * @param {string} spec.artifactPath  产物路径
 * @param {string[]} spec.sourceFiles 参与构建的源文件绝对/相对路径
 * @param {string} [spec.entry]       入口
 * @param {string} [spec.toolchain]   工具链标识
 * @param {string} [spec.rootDir]     源根（用于相对化 name）
 * @returns {object} manifest
 */
function buildManifest(spec = {}) {
  const rootDir = spec.rootDir || process.cwd();
  const sources = (spec.sourceFiles || []).map((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(rootDir, p);
    return {
      name: path.relative(rootDir, abs).split(path.sep).join('/'),
      sha256: _sha256File(abs),
      size: (() => { try { return fs.statSync(abs).size; } catch { return null; } })(),
    };
  });
  return {
    manifestVersion: MANIFEST_VERSION,
    artifact: {
      name: spec.artifactPath ? path.basename(spec.artifactPath) : null,
      sha256: spec.artifactPath ? _sha256File(spec.artifactPath) : null,
    },
    entry: spec.entry || null,
    toolchain: spec.toolchain || null,
    sourceCount: sources.length,
    sources,
  };
}

/** 落盘清单（显式写副作用；返回写入路径）。 */
function writeManifest(manifest, destPath) {
  const out = destPath || path.join(process.cwd(), MANIFEST_BASENAME);
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2), 'utf8');
  return out;
}

/** 读取清单（不存在/损坏返回 null，绝不抛）。 */
function loadManifest(srcPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    if (parsed && parsed.manifestVersion) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** 在产物同目录探测约定清单文件。 */
function findManifestFor(artifactPath) {
  try {
    const dir = path.dirname(artifactPath);
    const cand = path.join(dir, MANIFEST_BASENAME);
    if (fs.existsSync(cand)) return cand;
  } catch { /* noop */ }
  return null;
}

/** 文件名规整（去目录、统一斜杠、小写比较用）便于跨打包路径匹配。 */
function _basenameKey(name) {
  return String(name).split(/[/\\]/).pop().toLowerCase();
}

/**
 * 比对：还原结果 vs 构建清单 → 保真度评分。
 * @param {object} scan        artifactScanner 结果（用于产物哈希核对）
 * @param {object} recover     sourceRecoverer 结果（recovered members）
 * @param {object} manifest    buildManifest/loadManifest 结果
 * @returns {object} VerificationReport
 */
function verify(scan, recover, manifest) {
  if (!manifest || !Array.isArray(manifest.sources)) {
    return {
      hasBaseline: false,
      verdict: 'no-baseline',
      message: '无构建清单基线：仅产出还原快照，无法做保真度判定。可在 khy 构建时记录清单以启用自验。',
      fidelity: null,
    };
  }

  // 1) 产物哈希核对（最强的「同一性」证据）。
  const artifactHashMatch = manifest.artifact && manifest.artifact.sha256
    ? (manifest.artifact.sha256 === scan.sha256)
    : null;

  // 2) 源文件覆盖：清单里的源文件，有多少在还原成员里按 basename 命中。
  const recoveredKeys = new Set((recover.members || []).map((m) => _basenameKey(m.name)));
  const matched = [];
  const missing = [];
  for (const s of manifest.sources) {
    const key = _basenameKey(s.name);
    if (recoveredKeys.has(key)) matched.push(s.name);
    else missing.push(s.name);
  }
  const coverage = manifest.sources.length > 0 ? matched.length / manifest.sources.length : 0;

  // 3) 还原出但清单未登记的「额外」成员（仅源类，资产不计）。
  const manifestKeys = new Set(manifest.sources.map((s) => _basenameKey(s.name)));
  const extra = (recover.members || [])
    .filter((m) => m.kind === 'source' && !manifestKeys.has(_basenameKey(m.name)))
    .map((m) => m.name);

  // 保真度评分：产物同一性占 50%（可判定时），源覆盖占 50%。
  let fidelity;
  if (artifactHashMatch === null) {
    fidelity = Math.round(coverage * 100);
  } else {
    fidelity = Math.round((artifactHashMatch ? 50 : 0) + coverage * 50);
  }

  let verdict;
  if (artifactHashMatch === true && coverage >= 0.95) verdict = 'verified';
  else if (coverage >= 0.6 || artifactHashMatch === true) verdict = 'partial';
  else verdict = 'mismatch';

  return {
    hasBaseline: true,
    verdict,
    fidelity,
    artifactHashMatch,
    coverage: Number(coverage.toFixed(3)),
    matchedCount: matched.length,
    missingCount: missing.length,
    matched,
    missing,
    extra,
    message:
      verdict === 'verified'
        ? '产物哈希与源覆盖均匹配清单：高保真自验通过。'
        : verdict === 'partial'
          ? '部分匹配：产物同一性或源覆盖之一达标，存在缺口（见 missing）。'
          : '不匹配：产物哈希与源覆盖均未达标，疑似非同一构建或还原不足。',
  };
}

module.exports = {
  MANIFEST_VERSION,
  MANIFEST_BASENAME,
  buildManifest,
  writeManifest,
  loadManifest,
  findManifestFor,
  verify,
  _basenameKey,
};
