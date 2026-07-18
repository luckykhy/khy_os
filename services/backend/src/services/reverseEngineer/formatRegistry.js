'use strict';

/**
 * formatRegistry.js — 制品格式「单一真源」(DESIGN-ARCH-054 §3.1)。
 *
 * 把「一个二进制/打包产物长什么样」的全部知识收敛成一张声明式表：魔数签名、所属家族、
 * 可还原档位、以及哪些外部反编译/反汇编器能进一步处理它。逆向流水线其余模块（分诊 /
 * 源码还原 / 工具编排 / 重建）都**只读**本表，零散落硬编码。
 *
 * 设计铁律：
 *   - 签名是「偏移 + 字节序列」声明式条目，匹配逻辑在 artifactScanner，本表不含命令式代码。
 *   - 可还原档位 recoverability 决定 khy 能把产物「还原」到多近源码：
 *       SOURCE   自包含解释型打包(asar/jar 资源/PyInstaller/Node SEA) —— 常可取回近乎原始源码，
 *                这是验证「khy 生成的软件」最强的一条路径。
 *       BYTECODE 字节码/托管 IL(.class/.pyc/.NET) —— 需反编译器，能还原到高保真伪源码。
 *       NATIVE   原生机器码(PE/ELF/Mach-O/WASM) —— 仅反汇编 + 符号/字符串 + 模型推断结构。
 *       ARCHIVE  通用归档(zip/tar/gzip) —— 解包后对每个成员递归分诊。
 *   - tools 字段只声明「候选」外部工具名；是否真的存在由 toolOrchestrator 运行时探活，
 *     绝不假设工具存在（防呆②：无工具如实上报，绝不伪造反编译输出）。
 */

/** 可还原档位枚举（对外稳定常量）。 */
const RECOVERABILITY = Object.freeze({
  SOURCE: 'source',
  BYTECODE: 'bytecode',
  NATIVE: 'native',
  ARCHIVE: 'archive',
  UNKNOWN: 'unknown',
});

/**
 * 把人类可读的十六进制串（"7f454c46" 或 "7f 45 4c 46"）转成 Buffer。
 * 仅在模块加载期调用，便于签名以可读形式书写。
 */
function _hex(str) {
  return Buffer.from(String(str).replace(/[^0-9a-fA-F]/g, ''), 'hex');
}

/**
 * 制品格式描述符表（单一真源）。
 * 每条：
 *   id            稳定标识
 *   label         人类可读标签
 *   family        粗分家族（pe/elf/macho/dotnet/java/python/node/wasm/archive/script/...）
 *   recoverability 见 RECOVERABILITY
 *   signatures    [{ offset, bytes:Buffer }]；任一命中即判定该格式（artifactScanner 负责匹配）
 *   ext           典型扩展名（仅作旁证，绝不单凭扩展名判定）
 *   tools         候选外部反编译/反汇编器名（运行时探活，见 toolOrchestrator）
 *   note          还原策略提示
 */
const FORMATS = [
  // ── 原生可执行 ────────────────────────────────────────────────
  {
    id: 'pe',
    label: 'Windows PE (EXE/DLL)',
    family: 'pe',
    recoverability: RECOVERABILITY.NATIVE,
    signatures: [{ offset: 0, bytes: _hex('4d5a') }], // "MZ"
    ext: ['.exe', '.dll', '.sys'],
    tools: ['radare2', 'r2', 'objdump', 'dumpbin', 'ilspycmd'],
    note: 'MZ/PE header; .NET 子类型由 CLI 目录二次判定（见 dotnet）。',
  },
  {
    id: 'elf',
    label: 'Linux ELF',
    family: 'elf',
    recoverability: RECOVERABILITY.NATIVE,
    signatures: [{ offset: 0, bytes: _hex('7f454c46') }], // 0x7F E L F
    ext: ['', '.so', '.elf', '.bin'],
    tools: ['radare2', 'r2', 'objdump', 'nm', 'readelf'],
    note: 'ELF header；可读 program/section headers + 动态符号。',
  },
  {
    id: 'macho',
    label: 'macOS Mach-O',
    family: 'macho',
    recoverability: RECOVERABILITY.NATIVE,
    signatures: [
      { offset: 0, bytes: _hex('feedface') }, // 32-bit
      { offset: 0, bytes: _hex('feedfacf') }, // 64-bit
      { offset: 0, bytes: _hex('cffaedfe') }, // 64-bit LE
      { offset: 0, bytes: _hex('cafebabe') }, // fat/universal (与 Java class 撞，需二次判定)
    ],
    ext: ['', '.dylib'],
    tools: ['radare2', 'r2', 'otool', 'nm', 'objdump'],
    note: 'cafebabe 与 Java class 魔数相同；artifactScanner 用后续字节区分 fat-macho 与 class。',
  },
  {
    id: 'wasm',
    label: 'WebAssembly',
    family: 'wasm',
    recoverability: RECOVERABILITY.NATIVE,
    signatures: [{ offset: 0, bytes: _hex('0061736d') }], // \0asm
    ext: ['.wasm'],
    tools: ['wasm2wat', 'wasm-decompile', 'wasm-objdump'],
    note: 'wasm2wat 可还原到 WAT 文本，已接近可读。',
  },

  // ── 托管/字节码 ───────────────────────────────────────────────
  {
    id: 'java-class',
    label: 'Java class',
    family: 'java',
    recoverability: RECOVERABILITY.BYTECODE,
    signatures: [{ offset: 0, bytes: _hex('cafebabe') }],
    ext: ['.class'],
    tools: ['jadx', 'procyon', 'cfr', 'javap'],
    note: 'cafebabe + 次版本/主版本字节；与 macho-fat 区分见 scanner。',
  },
  {
    id: 'dex',
    label: 'Android Dalvik bytecode (.dex)',
    family: 'dalvik',
    recoverability: RECOVERABILITY.BYTECODE,
    // "dex\n" + 3 位版本号 + 0x00：035/036/037/038/039。前 4 字节固定，版本号容版本漂移。
    signatures: [{ offset: 0, bytes: Buffer.from('dex\n', 'ascii') }],
    ext: ['.dex'],
    tools: ['jadx', 'baksmali', 'd2j-dex2jar'],
    note: 'Dalvik 字节码：jadx 直接反编译回 Java；baksmali 出 smali；dex2jar 转 jar。',
  },

  // ── 自包含打包（源码可还原，验证 khy 产物的主路径）────────────────
  {
    id: 'archive-zip',
    label: 'ZIP / JAR / asar(zip) / wheel / nupkg',
    family: 'archive',
    recoverability: RECOVERABILITY.SOURCE,
    signatures: [
      { offset: 0, bytes: _hex('504b0304') }, // PK\3\4
      { offset: 0, bytes: _hex('504b0506') }, // empty archive
      { offset: 0, bytes: _hex('504b0708') }, // spanned
    ],
    ext: ['.zip', '.jar', '.war', '.whl', '.nupkg', '.apk', '.asar'],
    tools: [],
    note: 'JAR 内含 .class（再走 java-class 反编译）+ 资源/源码；wheel/asar 常含可读源码。',
  },
  {
    id: 'archive-tar',
    label: 'TAR',
    family: 'archive',
    recoverability: RECOVERABILITY.ARCHIVE,
    signatures: [{ offset: 257, bytes: Buffer.from('ustar', 'ascii') }],
    ext: ['.tar'],
    tools: [],
    note: 'POSIX tar magic 在 offset 257；解包后逐成员递归分诊。',
  },
  {
    id: 'archive-gzip',
    label: 'gzip',
    family: 'archive',
    recoverability: RECOVERABILITY.ARCHIVE,
    signatures: [{ offset: 0, bytes: _hex('1f8b') }],
    ext: ['.gz', '.tgz'],
    tools: [],
    note: '解压后通常是 tar 或单文件，递归分诊。',
  },
  {
    id: 'archive-7z',
    label: '7-Zip',
    family: 'archive',
    recoverability: RECOVERABILITY.ARCHIVE,
    signatures: [{ offset: 0, bytes: _hex('377abcaf271c') }], // 7z\xBC\xAF\x27\x1C
    ext: ['.7z'],
    tools: [],
    note: '7z 容器；解包后逐成员递归分诊。',
  },
  {
    id: 'archive-xz',
    label: 'xz',
    family: 'archive',
    recoverability: RECOVERABILITY.ARCHIVE,
    signatures: [{ offset: 0, bytes: _hex('fd377a585a00') }], // \xFD 7zXZ \x00
    ext: ['.xz'],
    tools: [],
    note: 'xz 压缩流；解压后通常是 tar，递归分诊。',
  },
  {
    id: 'archive-bzip2',
    label: 'bzip2',
    family: 'archive',
    recoverability: RECOVERABILITY.ARCHIVE,
    signatures: [{ offset: 0, bytes: Buffer.from('BZh', 'ascii') }],
    ext: ['.bz2', '.tbz2'],
    tools: [],
    note: 'bzip2 压缩流；解压后递归分诊。',
  },
  {
    id: 'archive-zstd',
    label: 'Zstandard',
    family: 'archive',
    recoverability: RECOVERABILITY.ARCHIVE,
    signatures: [{ offset: 0, bytes: _hex('28b52ffd') }],
    ext: ['.zst'],
    tools: [],
    note: 'zstd 压缩流；解压后递归分诊。',
  },
  {
    id: 'archive-rar',
    label: 'RAR',
    family: 'archive',
    recoverability: RECOVERABILITY.ARCHIVE,
    signatures: [
      { offset: 0, bytes: _hex('526172211a0700') },   // RAR 1.5–4.x: Rar!\x1A\x07\x00
      { offset: 0, bytes: _hex('526172211a070100') }, // RAR 5.0+:   Rar!\x1A\x07\x01\x00
    ],
    ext: ['.rar'],
    tools: [],
    note: 'RAR 容器（v4 与 v5 魔数不同）；解包后递归分诊。',
  },
  {
    id: 'archive-ar',
    label: 'Unix ar / .deb / static lib',
    family: 'archive',
    recoverability: RECOVERABILITY.ARCHIVE,
    signatures: [{ offset: 0, bytes: Buffer.from('!<arch>\n', 'ascii') }],
    ext: ['.a', '.deb', '.ar'],
    tools: [],
    note: 'Unix ar 归档（.deb 包/静态库 .a）；解包后逐成员递归分诊。',
  },

  // ── 脚本/文本（已是源码，无需还原，仅登记）─────────────────────
  {
    id: 'script-shebang',
    label: 'Script (shebang)',
    family: 'script',
    recoverability: RECOVERABILITY.SOURCE,
    signatures: [{ offset: 0, bytes: Buffer.from('#!', 'ascii') }],
    ext: ['.sh', '.py', '.pl', '.rb'],
    tools: [],
    note: '已是源码；逆向退化为「直接读」。',
  },
  {
    id: 'python-pyc',
    label: 'Python bytecode (.pyc)',
    family: 'python',
    recoverability: RECOVERABILITY.BYTECODE,
    // pyc 魔数随版本变化（前两字节 + 0d0a）；这里登记常见模式，scanner 容忍版本漂移。
    signatures: [
      { offset: 2, bytes: _hex('0d0a') }, // \r\n at byte 2-3 是 pyc 的稳定结构特征
    ],
    ext: ['.pyc'],
    tools: ['decompyle3', 'uncompyle6', 'pycdc'],
    note: '魔数随 CPython 版本漂移；用 offset2 的 0d0a 结构特征 + .pyc 扩展双证据降低误判。',
  },
];

/**
 * 仅靠内容签名无法判定、但能从「已识别格式的内部线索」二次升级的子类型。
 * 这些不是顶层签名，而是 artifactScanner 在初判后用嵌入标记进一步细化的依据。
 * 同样是声明式单一真源，匹配逻辑在 scanner / sourceRecoverer。
 */
const EMBEDDED_MARKERS = [
  {
    id: 'dotnet',
    label: '.NET assembly (managed PE)',
    family: 'dotnet',
    recoverability: RECOVERABILITY.BYTECODE,
    appliesTo: 'pe',
    // PE 内出现 CLR 元数据签名 "BSJB" (字节 42 53 4A 42) 即托管程序集。
    contentMarker: _hex('42534a42'),
    tools: ['ilspycmd', 'ilspy', 'dotnet-ildasm', 'monodis'],
    note: '托管 PE：ilspycmd 可反编译回近乎原始 C#。',
  },
  {
    id: 'pyinstaller',
    label: 'PyInstaller bundle',
    family: 'python',
    recoverability: RECOVERABILITY.SOURCE,
    appliesTo: 'any',
    // CArchive cookie magic，出现在文件尾部。
    contentMarker: Buffer.from('MEI\x0c\x0b\x0a\x0b\x0e', 'binary'),
    tools: ['pyinstxtractor', 'decompyle3', 'uncompyle6'],
    note: 'PyInstaller CArchive：可抽出 .pyc，再反编译回 .py（khy 打包 Python 的主验证路径）。',
  },
  {
    id: 'node-sea',
    label: 'Node.js Single Executable / pkg / nexe',
    family: 'node',
    recoverability: RECOVERABILITY.SOURCE,
    appliesTo: 'any',
    // Node SEA fuse / pkg payload sentinel 字符串特征（任一命中视为 Node 自包含）。
    contentMarker: Buffer.from('NODE_SEA_BLOB', 'ascii'),
    altMarkers: [
      Buffer.from('PAYLOAD_POSITION', 'ascii'), // vercel/pkg
      Buffer.from('__NEXE_PATCH__', 'ascii'),    // nexe
    ],
    tools: [],
    note: 'Node 自包含可执行内嵌 JS 源（pkg snapshot/SEA blob），常可取回近原始源码。',
  },
  {
    id: 'go-binary',
    label: 'Go binary',
    family: 'go',
    recoverability: RECOVERABILITY.NATIVE,
    appliesTo: 'any',
    contentMarker: Buffer.from('Go build ID:', 'ascii'),
    altMarkers: [Buffer.from('go.buildinfo', 'ascii')],
    tools: ['radare2', 'r2', 'objdump', 'go'],
    note: 'Go buildinfo 携带模块/版本，可还原依赖图。',
  },
  {
    id: 'rust-binary',
    label: 'Rust binary',
    family: 'rust',
    recoverability: RECOVERABILITY.NATIVE,
    appliesTo: 'any',
    contentMarker: Buffer.from('rustc-', 'ascii'),
    tools: ['radare2', 'r2', 'objdump'],
    note: 'rustc 版本串 + panic 路径字符串可还原 crate 结构线索。',
  },
  {
    id: 'apk',
    label: 'Android APK',
    family: 'dalvik',
    // APK 本体是 zip(archive-zip, SOURCE)；这里只作标注 + 浮出 dalvik 反编译器候选，
    // 不降级可还原档位（zip 成员抽取仍是更强路径；classes.dex 抽出后可单独走 dex 反编译）。
    appliesTo: 'archive-zip',
    contentMarker: Buffer.from('AndroidManifest.xml', 'ascii'),
    altMarkers: [Buffer.from('classes.dex', 'ascii')],
    tools: ['jadx', 'baksmali', 'd2j-dex2jar'],
    note: 'APK = zip 容器内含 classes.dex + 资源；jadx 可直接吃 .apk 反编译回 Java。',
  },
];

/** 列出全部顶层格式描述符（冻结副本，调用方不可变更单一真源）。 */
function listFormats() {
  return FORMATS.map((f) => Object.freeze({ ...f }));
}

/** 列出全部嵌入标记描述符。 */
function listEmbeddedMarkers() {
  return EMBEDDED_MARKERS.map((m) => Object.freeze({ ...m }));
}

/** 按 id 取格式（含嵌入标记），未命中返回 null。 */
function getById(id) {
  return (
    FORMATS.find((f) => f.id === id) ||
    EMBEDDED_MARKERS.find((m) => m.id === id) ||
    null
  );
}

/** 该格式 family 的全部候选外部工具（去重）。 */
function candidateTools(formatId) {
  const f = getById(formatId);
  if (!f) return [];
  return Array.from(new Set([...(f.tools || [])]));
}

module.exports = {
  RECOVERABILITY,
  FORMATS,
  EMBEDDED_MARKERS,
  listFormats,
  listEmbeddedMarkers,
  getById,
  candidateTools,
};
