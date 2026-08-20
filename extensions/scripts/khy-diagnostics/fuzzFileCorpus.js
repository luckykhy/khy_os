'use strict';
/**
 * 文件/图片/压缩包/文档 对抗式语料生成器(确定性,零随机)。
 *
 * 与 fuzzInputCorpus.js(纯文本输入框)互补:这里生成喂给 khyos **文件摄入通道**
 * 的对抗载荷——图片 magic 字节、非常见格式(BMP/TIFF/HEIC/SVG)、截断头、错扩展名、
 * 畸形 zip/tar/gzip、伪装成 zip 的 docx、超大/负偏移的 ELF/PE 头、畸形 data-URL、
 * 超长/截断 base64、以及各种恶劣路径字符串。
 *
 * 两种载荷:
 *   - Buffer 类(bufferCases):喂给吃 Buffer 的分类器(detectByMagic/detectFormat/
 *     parseELF/parsePE/looksBinary/decodeBuffer)。
 *   - 字符串/对象类(pathCases / itemCases):喂给吃路径串或 image/doc item 的解析器
 *     (detectInlineMediaPaths/archiveStrategyForPath/normalizeImageItem/normalizeDocItem)。
 *
 * 刻意零 Math.random:失败 100% 可复现。生成器零 IO,可单测。
 */

function B(id, category, note, buffer, name = '') {
  return { id, category, note, buffer, name };
}
function P(id, category, note, input) {
  return { id, category, note, input };
}
function I(id, category, note, item) {
  return { id, category, note, item };
}

// 便捷:拼接字节数组与字符串片段成 Buffer。
function bytes(...parts) {
  const bufs = parts.map((p) =>
    Buffer.isBuffer(p) ? p : Array.isArray(p) ? Buffer.from(p) : Buffer.from(String(p), 'latin1'),
  );
  return Buffer.concat(bufs);
}

/** 生成吃 Buffer 的对抗用例。 */
function buildBufferCorpus() {
  const cases = [];

  // ── 1. 图片 magic —— 合法头 / 截断 / 错扩展 ────────────────────────────────
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const JPG = [0xff, 0xd8, 0xff, 0xe0];
  const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
  cases.push(B('png-valid', 'image', '合法 PNG 头', bytes(PNG, [0, 0, 0, 13]), 'a.png'));
  cases.push(B('png-truncated-3', 'image', 'PNG 头仅 3 字节', bytes([0x89, 0x50, 0x4e]), 'a.png'));
  cases.push(B('jpg-valid', 'image', '合法 JPEG 头', bytes(JPG), 'a.jpg'));
  cases.push(B('jpg-1byte', 'image', 'JPEG 仅 1 字节', bytes([0xff]), 'a.jpg'));
  cases.push(B('gif-valid', 'image', '合法 GIF89a', bytes(GIF), 'a.gif'));
  cases.push(B('png-bytes-jpg-ext', 'image', 'PNG 字节但 .jpg 扩展(内容≠扩展)', bytes(PNG), 'photo.jpg'));
  cases.push(B('empty-buf', 'image', '零字节 Buffer', Buffer.alloc(0), 'empty.png'));

  // ── 2. WEBP —— 两个 sniffer 分歧点(RIFF-only vs RIFF+WEBP fourcc) ─────────
  cases.push(B('webp-full', 'image', '完整 RIFF....WEBP', bytes('RIFF', [0, 0, 0, 0], 'WEBP'), 'a.webp'));
  cases.push(B('riff-not-webp', 'image', 'RIFF 但非 WEBP(是 WAVE)', bytes('RIFF', [0, 0, 0, 0], 'WAVE'), 'a.wav'));
  cases.push(B('riff-truncated', 'image', 'RIFF 头后截断(无 fourcc)', bytes('RIFF'), 'a.webp'));

  // ── 3. 非常见图片格式(BMP/TIFF/HEIC/SVG/ICO)—— magic 不识别只靠扩展 ─────
  cases.push(B('bmp-magic', 'uncommon-image', 'BMP magic BM', bytes('BM', [0x36, 0x00, 0x00, 0x00]), 'a.bmp'));
  cases.push(B('tiff-le', 'uncommon-image', 'TIFF 小端 II*\\0', bytes([0x49, 0x49, 0x2a, 0x00]), 'a.tiff'));
  cases.push(B('tiff-be', 'uncommon-image', 'TIFF 大端 MM\\0*', bytes([0x4d, 0x4d, 0x00, 0x2a]), 'a.tif'));
  cases.push(B('heic-ftyp', 'uncommon-image', 'HEIC ftypheic box', bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0]), 'a.heic'));
  cases.push(B('avif-ftyp', 'uncommon-image', 'AVIF ftypavif box', bytes([0, 0, 0, 0x18], 'ftypavif', [0, 0, 0, 0]), 'a.avif'));
  cases.push(B('svg-xml', 'uncommon-image', 'SVG(XML 文本冒充图片)', bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), 'a.svg'));
  cases.push(B('svg-nodecl', 'uncommon-image', '裸 <svg> 无 XML 声明', bytes('<svg onload="alert(1)"></svg>'), 'a.svg'));
  cases.push(B('ico-magic', 'uncommon-image', 'ICO 头', bytes([0x00, 0x00, 0x01, 0x00]), 'a.ico'));
  cases.push(B('bmp-magic-png-ext', 'uncommon-image', 'BMP 字节但 .png 扩展', bytes('BM'), 'x.png'));

  // ── 4. 压缩包 —— zip/tar/gzip 合法与畸形 ──────────────────────────────────
  cases.push(B('zip-local', 'archive', 'ZIP 本地文件头 PK\\x03\\x04', bytes([0x50, 0x4b, 0x03, 0x04]), 'a.zip'));
  cases.push(B('zip-eocd-empty', 'archive', '空 ZIP(仅 EOCD PK\\x05\\x06)', bytes([0x50, 0x4b, 0x05, 0x06], Buffer.alloc(18)), 'a.zip'));
  cases.push(B('zip-pk-truncated', 'archive', 'PK 后截断', bytes([0x50, 0x4b]), 'a.zip'));
  cases.push(B('tar-header', 'archive', 'tar(ustar 魔数在 257)', bytes(Buffer.alloc(257), 'ustar', [0x00]), 'a.tar'));
  cases.push(B('gzip-magic', 'archive', 'gzip \\x1f\\x8b', bytes([0x1f, 0x8b, 0x08, 0x00]), 'a.gz'));
  cases.push(B('zip-bomb-names', 'archive', 'ZIP 头+超长伪条目名', bytes([0x50, 0x4b, 0x03, 0x04], 'A'.repeat(70000)), 'a.zip'));

  // ── 5. OOXML —— docx/xlsx/pptx(zip 内含标志文件名)与伪装 ─────────────────
  cases.push(B('docx-marker', 'document', 'docx(zip 含 word/document.xml)', bytes([0x50, 0x4b, 0x03, 0x04], 'x'.repeat(30), 'word/document.xml', 'y'.repeat(30)), 'a.docx'));
  cases.push(B('xlsx-marker', 'document', 'xlsx(zip 含 xl/workbook.xml)', bytes([0x50, 0x4b, 0x03, 0x04], 'xl/workbook.xml'), 'a.xlsx'));
  cases.push(B('pptx-marker', 'document', 'pptx(zip 含 ppt/presentation.xml)', bytes([0x50, 0x4b, 0x03, 0x04], 'ppt/presentation.xml'), 'a.pptx'));
  cases.push(B('docx-not-zip', 'document', 'docx 扩展但非 zip(纯文本)', bytes('This is not really a zip file, just text pretending.'), 'fake.docx'));
  cases.push(B('doc-ole', 'document', '老式 .doc OLE 魔数', bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'a.doc'));
  cases.push(B('pdf-magic', 'document', 'PDF %PDF-', bytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'), 'a.pdf'));
  cases.push(B('pdf-truncated', 'document', 'PDF 头后立即 EOF', bytes('%PDF-'), 'a.pdf'));
  cases.push(B('rtf-magic', 'document', 'RTF {\\rtf', bytes('{\\rtf1\\ansi'), 'a.rtf'));

  // ── 6. ELF —— 合法与畸形头(手写 parser 越界高危面) ──────────────────────
  const elfBase = () => {
    const b = Buffer.alloc(128);
    b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46; // \x7FELF
    b[4] = 2; // 64-bit
    b[5] = 1; // little-endian
    b.writeUInt16LE(0x3e, 18); // x86_64
    b.writeUInt16LE(2, 16);    // executable
    return b;
  };
  cases.push(B('elf-minimal', 'binary-elf', '最小合法 ELF64 头', elfBase(), 'a.out'));
  {
    // shoff 巨大 → 越界判定应回退,不得抛。
    const b = elfBase();
    b.writeBigUInt64LE(0xffffffffffffff00n, 40); // shoff huge
    b.writeUInt16LE(64, 58); // shentsize
    b.writeUInt16LE(10, 60); // shnum
    cases.push(B('elf-huge-shoff', 'binary-elf', 'ELF shoff 巨大', b, 'a.out'));
  }
  {
    // shentsize=0 但 shoff 靠近末尾 → 越界读 readBigUInt64LE 高危抛点。
    const b = elfBase();
    b.writeBigUInt64LE(BigInt(b.length - 8), 40); // shoff near end
    b.writeUInt16LE(0, 58);   // shentsize = 0(病态)
    b.writeUInt16LE(4, 60);   // shnum
    b.writeUInt16LE(0, 62);   // shstrndx = 0 < shnum
    cases.push(B('elf-shentsize0-nearend', 'binary-elf', 'ELF shentsize=0 且 shoff 近末尾', b, 'a.out'));
  }
  {
    // shentsize 小(8)使 off+shentsize 通过但 off+32 越界。
    const b = elfBase();
    b.writeBigUInt64LE(BigInt(b.length - 16), 40);
    b.writeUInt16LE(8, 58);   // shentsize = 8(< 40 → off+32 越界)
    b.writeUInt16LE(2, 60);   // shnum
    b.writeUInt16LE(1, 62);   // shstrndx
    cases.push(B('elf-small-shentsize', 'binary-elf', 'ELF shentsize=8 → off+32 越界', b, 'a.out'));
  }
  {
    // phnum 巨大 + phoff 靠近末尾 → PT_DYNAMIC 循环越界。
    const b = elfBase();
    b.writeBigUInt64LE(BigInt(b.length - 4), 32); // phoff near end
    b.writeUInt16LE(56, 54);   // phentsize
    b.writeUInt16LE(0xffff, 56); // phnum huge
    cases.push(B('elf-huge-phnum', 'binary-elf', 'ELF phnum=65535 phoff 近末尾', b, 'a.out'));
  }
  cases.push(B('elf-magic-only', 'binary-elf', '仅 ELF 魔数后全 0(64 字节)', bytes([0x7f, 0x45, 0x4c, 0x46], Buffer.alloc(60)), 'a.out'));
  cases.push(B('elf-truncated-32', 'binary-elf', 'ELF 魔数但仅 32 字节(<64)', bytes([0x7f, 0x45, 0x4c, 0x46], Buffer.alloc(28)), 'a.out'));

  // ── 7. PE —— 合法与畸形头 ─────────────────────────────────────────────────
  const peBase = () => {
    const b = Buffer.alloc(256);
    b[0] = 0x4d; b[1] = 0x5a; // MZ
    b.writeUInt32LE(64, 60);  // e_lfanew → PE header at 64
    b.writeUInt32LE(0x00004550, 64); // "PE\0\0"
    b.writeUInt16LE(0x8664, 68);     // machine x86_64
    b.writeUInt16LE(1, 70);          // numSections
    b.writeUInt16LE(240, 84);        // optHeaderSize
    b.writeUInt16LE(0x020b, 88);     // PE32+ magic (optOff=88)
    return b;
  };
  cases.push(B('pe-minimal', 'binary-pe', '最小合法 PE64 头', peBase(), 'a.exe'));
  {
    const b = peBase();
    b.writeUInt32LE(0xfffffff0, 60); // e_lfanew huge
    cases.push(B('pe-huge-lfanew', 'binary-pe', 'PE e_lfanew 巨大', b, 'a.exe'));
  }
  {
    const b = peBase();
    b.writeUInt16LE(0xffff, 70); // numSections huge
    cases.push(B('pe-huge-sections', 'binary-pe', 'PE numSections=65535', b, 'a.exe'));
  }
  {
    const b = peBase();
    b.writeUInt16LE(0, 84); // optHeaderSize = 0
    cases.push(B('pe-optsize0', 'binary-pe', 'PE optHeaderSize=0', b, 'a.exe'));
  }
  cases.push(B('pe-mz-only', 'binary-pe', '仅 MZ 后全 0', bytes([0x4d, 0x5a], Buffer.alloc(62)), 'a.exe'));

  // ── 8. looksBinary / decodeBuffer 边界 ────────────────────────────────────
  cases.push(B('all-nul-256', 'encoding', '256 个 NUL', Buffer.alloc(256), 'a.bin'));
  cases.push(B('high-bytes', 'encoding', '全 0xFF 高位字节', Buffer.alloc(64, 0xff), 'a.bin'));
  cases.push(B('utf16-bom-le', 'encoding', 'UTF-16LE BOM', bytes([0xff, 0xfe], 'h\x00i\x00'), 'a.txt'));
  cases.push(B('utf8-bom', 'encoding', 'UTF-8 BOM', bytes([0xef, 0xbb, 0xbf], 'hello'), 'a.txt'));
  cases.push(B('invalid-utf8', 'encoding', '非法 UTF-8 续字节', bytes([0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28]), 'a.txt'));
  cases.push(B('mixed-text-nul', 'encoding', '文本内嵌 NUL', bytes('hello\x00world\x00'), 'a.txt'));

  return cases;
}

/** 生成吃「路径字符串」的对抗用例(detectInlineMediaPaths / archiveStrategyForPath 等)。 */
function buildPathCorpus() {
  const cases = [];

  cases.push(P('path-empty', 'path', '空路径', ''));
  cases.push(P('path-long', 'path', '超长路径 5 万字符', '/tmp/' + 'a'.repeat(50000) + '.png'));
  cases.push(P('path-null-byte', 'path', '内嵌 NUL 的路径', '/tmp/a\x00b.png'));
  cases.push(P('path-traversal', 'path', '路径穿越 .png', '../'.repeat(2000) + 'etc/passwd.png'));
  cases.push(P('path-file-uri', 'path', 'file:// URI', 'file:///etc/passwd'));
  cases.push(P('path-win-drive', 'path', 'Windows /C: 前缀', '/C:/Users/x/pic.bmp'));
  cases.push(P('path-unc', 'path', 'UNC 路径', '\\\\server\\share\\a.png'));
  cases.push(P('path-device', 'path', '设备路径', '/dev/zero'));
  cases.push(P('path-cjk', 'path', 'CJK 文件名', '/tmp/图片文档.png'));
  cases.push(P('path-spaces-quotes', 'path', '含空格与引号', '"/tmp/my photo (1).jpeg"'));
  cases.push(P('path-newline', 'path', '路径含换行', '/tmp/a.png\n/tmp/b.jpg'));
  cases.push(P('path-compound-ext', 'path', '复合扩展 .tar.gz.zip', '/tmp/archive.tar.gz.zip'));
  cases.push(P('path-double-ext', 'path', '双扩展 .png.exe', '/tmp/pic.png.exe'));
  cases.push(P('path-no-ext', 'path', '无扩展名', '/tmp/justaname'));
  cases.push(P('path-uppercase-ext', 'path', '大写扩展 .PNG', '/tmp/A.PNG'));
  cases.push(P('path-many-mentions', 'path', '文本内多张图片路径', ('/tmp/a.png /tmp/b.jpg /tmp/c.bmp /tmp/d.gif ').repeat(2000)));
  cases.push(P('path-dotfiles', 'path', '隐藏文件多扩展', '.a.b.c.d.tiff'));
  cases.push(P('path-only-ext', 'path', '仅扩展名', '.png'));
  cases.push(P('path-trailing-dot', 'path', '扩展后尾随点/空格', '/tmp/a.zip.  '));
  cases.push(P('path-emoji', 'path', 'emoji 文件名', '/tmp/😀📷.png'));

  return cases;
}

/** 生成吃「image/doc item」的对抗用例(normalizeImageItem / normalizeDocItem)。 */
function buildItemCorpus() {
  const cases = [];

  cases.push(I('item-null', 'item', 'null', null));
  cases.push(I('item-empty-str', 'item', '空串', ''));
  cases.push(I('item-plain-str', 'item', '裸字符串', 'just some text'));
  cases.push(I('item-data-url-png', 'item', '合法 data-URL PNG', 'data:image/png;base64,iVBORw0KGgo='));
  cases.push(I('item-data-url-nobase64', 'item', 'data-URL 无 base64 标记', 'data:image/png,rawdata'));
  cases.push(I('item-data-url-truncated', 'item', 'data-URL 截断', 'data:image/png;base64,'));
  cases.push(I('item-data-url-badmime', 'item', 'data-URL 畸形 mime', 'data:;;;base64,QQ=='));
  cases.push(I('item-huge-base64', 'item', '超长 base64 20 万字符', 'A'.repeat(200000)));
  cases.push(I('item-base64-badchars', 'item', 'base64 含非法字符', '!!!@@@###$$$%%%^^^&&&***'));
  cases.push(I('item-obj-base64', 'item', '{base64} 对象', { base64: 'QQ==', mimeType: 'image/bmp' }));
  cases.push(I('item-obj-path', 'item', '{path} 对象', { path: '/tmp/../../../etc/passwd' }));
  cases.push(I('item-obj-url', 'item', '{url} 对象', { url: 'http://x/y.png\x00' }));
  cases.push(I('item-obj-empty', 'item', '空对象', {}));
  cases.push(I('item-obj-nested', 'item', '深嵌套对象', { base64: { toString: () => { throw new Error('boom'); } } }));
  cases.push(I('item-obj-circular', 'item', '循环引用对象', (() => { const o = {}; o.self = o; o.base64 = 'QQ=='; return o; })()));
  cases.push(I('item-number', 'item', '数字', 12345));
  cases.push(I('item-array', 'item', '数组', ['a', 'b']));
  cases.push(I('item-doc-text', 'item', '{text} 文档 item', { text: 'x'.repeat(100000), mimeType: 'text/plain' }));

  return cases;
}

module.exports = {
  B, P, I, bytes,
  buildBufferCorpus,
  buildPathCorpus,
  buildItemCorpus,
};
