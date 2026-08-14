'use strict';

/**
 * restore-check-crypto.js — 还原「解密套件可执行性」CLI + 文档生成器
 *
 * 用法：
 *   node scripts/restore-check-crypto.js <还原目录 / 快照目录>          # 判：这个快照的加密套件，本机 khy 解得了吗？
 *   node scripts/restore-check-crypto.js <目录> --json                  # 机器可读（陌生机器上的自驱 agent 据此决定是否敢解密）
 *   node scripts/restore-check-crypto.js --gen-doc                      # 重新生成 OPS-MAN-110 说明
 *
 * 为谁而写：解密侧 sourceSnapshotCrypto.decrypt **只校验 `crypto.algo`，从不校验 `crypto.kdf`**——
 * `kdf` 在代码库里只有 encrypt 的盖章一处、零消费者。一个未来 `kdf:'argon2'` 的快照到了旧 khy，会被
 * 盲目按 scrypt 误派生密钥，最终抛 "unable to authenticate data" 被**误标成「口令错误」**——陌生机器上的
 * 用户以为密码打错了，真相却是「本机做不了这个 KDF」。本 CLI 是那个缺失的**解密前**对账器：把假的
 * 「口令错误」换成诚实的「本机做不了这个加密套件 / 快照材料残缺」。
 *
 * 设计：**判定全在纯叶子** scripts/lib/cryptoSuiteCompat.js（零 IO、零加密调用、可离线全测）；
 * 本文件是**采事实的接线壳**——读 snapshot.json 头喂给纯叶给出裁决。所有 IO（读 snapshot.json）
 * 都在此、fail-soft、绝不让异常冒泡成崩溃。
 *
 * 密钥卫生（红线）：本 CLI 与叶子**绝不读、绝不打印任何密钥/口令/明文材料**——只看 algo/kdf 字符串、
 * salt/iv/authTag 的**存在性**（是不是非空串），其值绝不离开判定、绝不落盘、绝不进输出。
 */

const fs = require('fs');
const path = require('path');

const {
  checkCryptoSuiteCompat,
} = require('../lib/cryptoSuiteCompat');

const ROOT = path.resolve(__dirname, '..', '..');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-110] 还原解密套件可执行性对账.md'
);
const NPM_PKG_NAME = '@khy-os/khy-os';
const PIP_PKG_NAME = 'khy-os';

const SNAPSHOT_META_NAME = 'snapshot.json';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

// ── 采事实：读快照头 ─────────────────────────────────────────────────────────

/** 安全读 JSON，失败返回 null（绝不抛）。 */
function _readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * 定位并读取快照头（snapshot.json）。找不到 → null。
 * 优先用 overrides.header 直接注入（离线可测），否则在目录及其常见 sidecar 位置找 snapshot.json。
 */
function _readHeader(destDir, overrides = {}) {
  if (overrides.header !== undefined) return overrides.header;
  const candidates = [
    overrides.snapshotMetaPath,
    path.join(destDir, SNAPSHOT_META_NAME),
    path.join(destDir, '_source', SNAPSHOT_META_NAME),
    path.join(path.dirname(destDir), '_source', SNAPSHOT_META_NAME),
  ].filter(Boolean);
  for (const p of candidates) {
    const header = _readJsonSafe(p);
    if (header && typeof header === 'object') return header;
  }
  return null;
}

/**
 * 采齐事实喂给纯叶，返回 { header, verdict, destDir }。不抛。
 * overrides 全可注入以便离线测试。
 */
function buildCryptoCheck(destDir, overrides = {}) {
  const dest = path.resolve(destDir || '.');
  const header = _readHeader(dest, overrides);
  const verdict = checkCryptoSuiteCompat(header);
  return { header, verdict, destDir: dest };
}

// ── 呈现层 ───────────────────────────────────────────────────────────────────

function runCheckCrypto(opts = {}) {
  const destArg = opts.destDir || '.';
  const { verdict, destDir } = buildCryptoCheck(destArg, opts.overrides || {});

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      status: verdict.status,
      ok: verdict.ok,
      algo: verdict.algo,
      kdf: verdict.kdf,
      supportedAlgos: verdict.supportedAlgos,
      supportedKdfs: verdict.supportedKdfs,
      missingMaterial: verdict.missingMaterial,
      dir: destDir,
      reason: verdict.reason,
    }, null, 2) + '\n');
    // 非 supported → 非零退出（陌生机器上的 agent 据此不敢盲目解密、不把失败当口令错）。
    return verdict.ok ? 0 : 2;
  }

  const statusColor = {
    supported: C.green,
    'unsupported-algo': C.red, 'unsupported-kdf': C.red, 'incomplete-material': C.red,
    unverifiable: C.yellow,
  }[verdict.status] || C.dim;

  let out = `${C.bold}Khy-OS 还原解密套件可执行性对账（这个快照的加密套件，本机解得了吗？）${C.reset}\n`;
  out += `${C.dim}渠道 pip ${PIP_PKG_NAME} / npm ${NPM_PKG_NAME}${C.reset}\n\n`;
  out += `${statusColor}${C.bold}[${verdict.status}]${C.reset} `
    + `algo=${verdict.algo == null ? '?' : verdict.algo} · `
    + `kdf=${verdict.kdf == null ? '(缺省)' : verdict.kdf} `
    + `${C.dim}(本机支持 [${verdict.supportedAlgos.join(', ')}] / [${verdict.supportedKdfs.join(', ')}])${C.reset}\n`;
  if (verdict.missingMaterial.length > 0) {
    out += `  ${C.red}缺解密材料：${verdict.missingMaterial.join(', ')}${C.reset}\n`;
  }
  out += `  ${C.bold}目录：${C.reset}${destDir}\n`;
  out += `  ${C.dim}判据：${verdict.reason}${C.reset}\n`;
  out += `\n${C.dim}诚实边界：套件陌生 / 材料残缺一律拒绝放行，绝不让它走到解密再报成假「口令错误」；只看 algo/kdf 与材料存在性，绝不碰密钥。${C.reset}\n`;
  out += `${C.dim}详情见：docs/07_OPS_运维/[OPS-MAN-110] 还原解密套件可执行性对账.md${C.reset}\n`;
  process.stdout.write(out);
  return verdict.ok ? 0 : 2;
}

// ── 文档生成（与叶子同源，防手改漂移）──────────────────────────────────────────

function buildDoc() {
  const lines = [];
  lines.push('# [OPS-MAN-110] 还原解密套件可执行性对账');
  lines.push('');
  lines.push('> 本文件由 `scripts/restore-check-crypto.js --gen-doc` 确定性生成，请勿手改；');
  lines.push('> 判定逻辑改在 `scripts/lib/cryptoSuiteCompat.js`，再重新生成。');
  lines.push('');
  lines.push('## 这一层闭合什么：crypto.kdf 是死字段，且失败信息会骗人');
  lines.push('');
  lines.push('快照构建期 `sourceSnapshotCrypto.encrypt` 给每个快照头盖全套加密契约：');
  lines.push('');
  lines.push('- `crypto.algo: "aes-256-gcm"` —— 对称加密算法；');
  lines.push('- `crypto.kdf: "scrypt"` —— 密钥派生函数（口令 → 密钥的算法）；');
  lines.push('- `crypto.scrypt: { N, r, p, keylen }` —— scrypt 代价参数；');
  lines.push('- `crypto.salt / iv / authTag` —— 派生盐 / 初始向量 / GCM 认证标签（解密必需）。');
  lines.push('');
  lines.push('但解密侧 `sourceSnapshotCrypto.decrypt` **只校验 `crypto.algo`，从不校验 `crypto.kdf`**——');
  lines.push('`grep kdf` 在整个代码库里只有一处：`encrypt` 的盖章（第 81 行），**零消费者**。更毒的是：');
  lines.push('');
  lines.push('- `decrypt` 读 scrypt 参数时是 `(c.scrypt && c.scrypt.N) || SCRYPT.N`——**盲目回退到写死的 scrypt 默认值**；');
  lines.push('- 一个未来 `kdf:"argon2"`（无 `c.scrypt` 块）的快照到了**旧** khy：`decrypt` 不看 kdf、照用 scrypt 派生，');
  lines.push('  派生出**错误的密钥**，`decipher.final()` 抛 `unable to authenticate data`，而调用方把这句');
  lines.push('  **映射成「口令错误 / wrong secret」**。');
  lines.push('');
  lines.push('→ 陌生机器上的用户被告知「密码不对」，真相却是「这台 khy 根本不会 argon2 这个 KDF」。');
  lines.push('这是离机还原里**最会误导人的假失败**。`crypto.kdf` 上游花心思盖章、跨渠道送达、下游能读，却');
  lines.push('**在解密前无人据此把关** = 死字段（断桥）。本层就是那个缺失的**解密前**消费者：把假的');
  lines.push('「口令错误」换成诚实的「本机做不了这个加密套件 / 快照材料残缺」。');
  lines.push('');
  lines.push('## 它和家族其它层的正交关系（别混淆）');
  lines.push('');
  lines.push('| 层 | 管什么 | 一句话 |');
  lines.push('|----|--------|--------|');
  lines.push('| 105 `snapshotFormatCompat` | 外层快照信封（`format`/`formatVersion`） | 「这是不是 khy 快照」 |');
  lines.push('| **110 本层 `cryptoSuiteCompat`** | **解密套件可执行性**（`algo`/`kdf` + 必需材料） | **「我做不做得了这个解密」** |');
  lines.push('| 108 `archiveExtractCompat` | 解密后内层归档形制（`plaintextFormat`/`layout`） | 「解开后我解不解得包」 |');
  lines.push('| 095 `completenessVerifier` | 解包后文件数 | 「落地数量对得上吗」 |');
  lines.push('');
  lines.push('顺序恰是还原流水线：信封(105) → **解密套件(本层 110)** → 真解密 → 内层归档(108) → 解包 → 完整性(095)。');
  lines.push('');
  lines.push('```bash');
  lines.push('node scripts/restore-check-format.js  ./Khy-OS --json   # ① 信封格式：本机看得懂吗？（105）');
  lines.push('node scripts/restore-check-crypto.js  ./Khy-OS --json   # ② 解密套件：本机解得了吗？（本层 110）');
  lines.push('node scripts/restore-check-archive.js ./Khy-OS --json   # ③ 内层归档：本机解包器解得开吗？（108）');
  lines.push('khy restore ./Khy-OS                                    # ④ 三门都过才敢真解密解包还原');
  lines.push('node scripts/restore-verify-complete.js ./Khy-OS --json # ⑤ 再对账数量：真完整吗？（095）');
  lines.push('```');
  lines.push('');
  lines.push('## 判定档：解密套件门（最保守优先）');
  lines.push('');
  lines.push('| 档 | 条件 | 裁决 | ok |');
  lines.push('|----|------|------|----|');
  lines.push('| 1 | 头非对象 / 数组 / 无 `crypto` 块 / `algo` 非非空串 | `unverifiable`：证据不足，绝不谎报 | ✗ |');
  lines.push('| 2 | `crypto.algo` ∉ 支持集 | `unsupported-algo`：本机执行不了这个算法，**先升级 khy** | ✗ |');
  lines.push('| 3 | `crypto.kdf` 存在且 ∉ 支持集 | `unsupported-kdf`：会误派生 → 假「口令错误」，**先升级 khy** | ✗ |');
  lines.push('| 4 | 缺 `salt`/`iv`/`authTag` 任一 | `incomplete-material`：快照残缺，**不是口令错误** | ✗ |');
  lines.push('| 5 | `algo` ∈ 支持集且（`kdf` 缺省 / ∈ 支持集）且材料齐全 | `supported`：唯一可安心进解密的档 | ✓ |');
  lines.push('');
  lines.push('- 本机解密真能执行的套件由叶子常量 `SUPPORTED_ALGOS` / `SUPPORTED_KDFS` 定义');
  lines.push('  （当前 `["aes-256-gcm"]` / `["scrypt"]`）；解密实现新增支持时按叶子 HOW-TO-EXTEND 同步——');
  lines.push('  **只有 decrypt 真能执行了才加进支持集**，别为绿灯谎报。');
  lines.push('- `--json` 在非 `supported` 时**退出码 2**：陌生机器上的自驱 agent 据此**不敢盲目解密**、');
  lines.push('  也**不把失败当口令错**。');
  lines.push('');
  lines.push('## 恒久红线（继承全家族 + 密钥卫生）');
  lines.push('');
  lines.push('- 套件陌生 / 材料残缺一律**拒绝放行**：绝不臆造 `supported`，绝不让残缺快照走到解密换来假「口令错误」。');
  lines.push('- **绝不读、绝不打印任何密钥/口令/明文材料**：只看 `algo`/`kdf` 字符串与 `salt`/`iv`/`authTag` 的**存在性**，');
  lines.push('  其值绝不离开判定、绝不落盘、绝不进输出。');
  lines.push('- `kdf` 缺省是老快照的合法向后兼容情形（decrypt 回退 scrypt）；但 `kdf` 一旦**存在**必须是认识的 KDF。');
  lines.push('- `ok===true` 仅当 `status === supported`；叶子纯计算、零 IO、零加密调用、绝不抛。');
  lines.push(`- 真 key/token 永不进包、不落盘；pip \`${PIP_PKG_NAME}\` 与 npm \`${NPM_PKG_NAME}\` 版本必须一致。`);
  lines.push('');
  return lines.join('\n') + '\n';
}

function writeDoc() {
  const content = buildDoc();
  fs.writeFileSync(DOC_PATH, content, 'utf8');
  process.stdout.write(
    `OK 写出还原解密套件可执行性对账说明 → ${path.relative(ROOT, DOC_PATH)} (${Buffer.byteLength(content)} bytes)\n`
  );
}

// ── CLI 入口 ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--gen-doc')) {
    writeDoc();
  } else {
    const destDir = argv.find((a) => a && !a.startsWith('-')) || '.';
    const code = runCheckCrypto({ destDir, json: argv.includes('--json') });
    process.exit(code);
  }
}

module.exports = {
  runCheckCrypto,
  buildCryptoCheck,
  _readHeader,
  buildDoc,
  writeDoc,
  DOC_PATH,
};
