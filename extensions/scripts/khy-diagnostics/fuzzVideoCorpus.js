'use strict';
/**
 * 视频输入 对抗式语料生成器(确定性,零随机)。
 *
 * 承 fuzzFileCorpus.js(图片/压缩包/文档),本文件专攻 khyos **视频摄入通道**:
 * 真实容器 magic(MP4/MOV ISO-BMFF、WebM/Matroska EBML、AVI RIFF、FLV、MPEG-PS/TS、3GP)
 * 的合法头 + 截断头 + 畸形 box 尺寸(0xffffffff / 超大声明)+ 错扩展名 + 零字节 +
 * 乱码字节 + 超长文件名。这些字节会被真正落盘成带视频扩展名的临时文件,喂给
 * mediaTranscriptionService / multimodalInputService 的真实编排路径。
 *
 * 另有「畸形 MIME 字符串」用例(videoMimeCorpus):喂给 mediaUnderstanding 的纯分类面
 * (mimeToCapability / findByMimeType / getBestProvider)—— 非字符串、超长、前缀碰撞、
 * 大小写、尾随垃圾。
 *
 * 刻意零 Math.random:失败 100% 可复现。生成器零 IO,可单测。
 */

function V(id, category, note, buffer, name = '') {
  return { id, category, note, buffer, name };
}

// 拼接字节数组/字符串片段成 Buffer(与 fuzzFileCorpus.bytes 同口径)。
function bytes(...parts) {
  const bufs = parts.map((p) =>
    Buffer.isBuffer(p) ? p : Array.isArray(p) ? Buffer.from(p) : Buffer.from(String(p), 'latin1'),
  );
  return Buffer.concat(bufs);
}

// 32 位大端(ISO-BMFF box size 是大端)。
function be32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** 生成落盘的视频字节对抗用例。 */
function buildVideoCorpus() {
  const cases = [];

  // ── 1. ISO-BMFF(MP4/MOV/3GP)—— ftyp box 合法 / 截断 / 畸形尺寸 ──────────
  // 合法 box:size(大端 4B)+ 'ftyp' + major_brand(4B)+ minor_version(4B)+ compatible_brands。
  const ftypIsom = bytes(be32(0x20), 'ftyp', 'isom', be32(0x200), 'isomiso2avc1mp41');
  cases.push(V('mp4-ftyp-isom', 'video', '合法 MP4 ftyp(isom)', ftypIsom, 'clip.mp4'));
  cases.push(V('mov-ftyp-qt', 'video', '合法 MOV ftyp(qt  )', bytes(be32(0x14), 'ftyp', 'qt  ', be32(0x200), 'qt  '), 'clip.mov'));
  cases.push(V('mp4-ftyp-mp42', 'video', 'MP4 ftyp(mp42)', bytes(be32(0x18), 'ftyp', 'mp42', be32(0), 'mp42isom'), 'clip.mp4'));
  cases.push(V('3gp-ftyp', 'video', '3GP ftyp(3gp5)', bytes(be32(0x14), 'ftyp', '3gp5', be32(0x200), '3gp5'), 'clip.mp4'));
  cases.push(V('mp4-ftyp-trunc3', 'video', 'ftyp 头仅前 3 字节(size)后截断', bytes([0x00, 0x00, 0x00]), 'clip.mp4'));
  cases.push(V('mp4-ftyp-no-brand', 'video', 'ftyp box 声明有 brand 但字节戛然而止', bytes(be32(0x20), 'ftyp'), 'clip.mp4'));
  // 畸形 box 尺寸:声明 0xffffffff(近 4GB)但实际只有几字节 —— 解析器若信任尺寸会越界/OOM。
  cases.push(V('mp4-box-size-max', 'video', 'ftyp box size=0xffffffff(谎报近 4GB)', bytes(be32(0xffffffff), 'ftyp', 'isom'), 'clip.mp4'));
  // box size=1 表示「用后续 64 位 largesize」,但 largesize 缺失。
  cases.push(V('mp4-box-size-1-no-large', 'video', 'box size=1(应读 64 位 largesize)却无 largesize', bytes(be32(1), 'ftyp'), 'clip.mp4'));
  // box size=0 表示「延伸到文件尾」——合法但空。
  cases.push(V('mp4-box-size-0', 'video', 'box size=0(延伸到 EOF)+ 空 body', bytes(be32(0), 'ftyp', 'isom'), 'clip.mp4'));
  // moov 在 mdat 之前但 moov 声明尺寸超出文件。
  cases.push(V('mp4-moov-oversize', 'video', 'moov box 声明尺寸远超实际字节', bytes(ftypIsom, be32(0x0fffffff), 'moov'), 'clip.mp4'));
  // ftyp 后紧跟畸形 mdat(声明负向/巨大)。
  cases.push(V('mp4-mdat-huge', 'video', 'mdat box 声明 0x7fffffff', bytes(ftypIsom, be32(0x7fffffff), 'mdat', [0x00, 0x01]), 'clip.mp4'));

  // ── 2. Matroska / WebM(EBML)—— magic 合法 / 截断 / 畸形 VINT ─────────────
  const EBML = [0x1a, 0x45, 0xdf, 0xa3];
  cases.push(V('webm-ebml-valid', 'video', '合法 EBML 头(WebM)', bytes(EBML, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]), 'clip.webm'));
  cases.push(V('mkv-ebml-valid', 'video', '合法 EBML 头(MKV)', bytes(EBML, [0xa3, 0x42, 0x86, 0x81, 0x01]), 'clip.mkv'));
  cases.push(V('webm-ebml-trunc', 'video', 'EBML magic 仅 3 字节', bytes([0x1a, 0x45, 0xdf]), 'clip.webm'));
  cases.push(V('webm-ebml-only', 'video', 'EBML magic 后立即 EOF', bytes(EBML), 'clip.webm'));
  // 畸形 VINT 长度描述符:0x00 前导字节非法(VINT 至少一位置 1)。
  cases.push(V('webm-vint-zero', 'video', 'EBML 后跟非法 VINT(全 0 前导)', bytes(EBML, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 'clip.webm'));

  // ── 3. AVI(RIFF)—— 合法 / 截断 / RIFF 非 AVI ────────────────────────────
  cases.push(V('avi-riff-valid', 'video', '合法 RIFF....AVI ', bytes('RIFF', be32(0x100), 'AVI ', 'LIST'), 'clip.avi'));
  cases.push(V('avi-riff-trunc', 'video', 'RIFF 头后截断(无 fourcc)', bytes('RIFF'), 'clip.avi'));
  cases.push(V('avi-riff-wrong-fourcc', 'video', 'RIFF 但 fourcc=JUNK(非 AVI)', bytes('RIFF', be32(0), 'JUNK'), 'clip.avi'));
  // RIFF size 谎报巨大。
  cases.push(V('avi-riff-size-max', 'video', 'RIFF size=0xffffffff', bytes('RIFF', be32(0xffffffff), 'AVI '), 'clip.avi'));

  // ── 4. FLV / MPEG-PS / MPEG-TS —— 少见容器 magic ─────────────────────────
  cases.push(V('flv-valid', 'video', '合法 FLV 头', bytes('FLV', [0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), 'clip.mp4'));
  cases.push(V('mpeg-ps-valid', 'video', 'MPEG-PS pack 头 00 00 01 BA', bytes([0x00, 0x00, 0x01, 0xba], [0x44, 0x00, 0x04, 0x00]), 'clip.mp4'));
  // MPEG-TS:0x47 sync byte,理应每 188 字节一个 —— 这里只放头部一个 + 垃圾。
  cases.push(V('mpeg-ts-sync', 'video', 'MPEG-TS sync 0x47 + 短 payload', bytes([0x47, 0x40, 0x00, 0x10], Buffer.alloc(184, 0xff)), 'clip.mkv'));

  // ── 5. 内容≠扩展 / 乱码 / 空 / 超长名 ───────────────────────────────────
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  cases.push(V('png-bytes-mp4-ext', 'mismatch', 'PNG 字节但 .mp4 扩展(内容≠扩展)', bytes(PNG), 'fake.mp4'));
  cases.push(V('text-bytes-webm-ext', 'mismatch', '纯文本字节但 .webm 扩展', bytes('this is not a video, just plain text\n'.repeat(4)), 'notavideo.webm'));
  cases.push(V('zero-mp4', 'edge', '零字节 .mp4', Buffer.alloc(0), 'empty.mp4'));
  cases.push(V('garble-mp4', 'garble', '256 字节高位乱码 .mp4', Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 37 + 11) & 0xff)), 'garble.mp4'));
  cases.push(V('garble-mkv', 'garble', '512 字节 0x00/0xff 交替 .mkv', Buffer.from(Array.from({ length: 512 }, (_, i) => (i % 2 ? 0xff : 0x00))), 'garble.mkv'));
  cases.push(V('nul-run-avi', 'garble', '4KB 全 NUL .avi', Buffer.alloc(4096, 0x00), 'nul.avi'));
  cases.push(V('longname-mp4', 'edge', '超长文件名(200 字符).mp4', bytes(be32(0x18), 'ftyp', 'isom'), `${'v'.repeat(200)}.mp4`));
  // 尾部是视频 magic 但前面塞垃圾(magic 不在偏移 0)。
  cases.push(V('ftyp-offset-4', 'edge', 'ftyp 不在偏移 0(前置 4 字节垃圾)', bytes([0xde, 0xad, 0xbe, 0xef], be32(0x18), 'ftyp', 'isom'), 'offset.mp4'));

  return cases;
}

/** 生成喂给 mediaUnderstanding 纯分类面的畸形 MIME 字符串。 */
function buildVideoMimeCorpus() {
  const cases = [];
  const M = (id, note, mime) => cases.push({ id, note, mime });
  M('video-mp4', '合法 video/mp4', 'video/mp4');
  M('video-webm', '合法 video/webm', 'video/webm');
  M('video-upper', '大写 VIDEO/MP4', 'VIDEO/MP4');
  M('video-mixed', '混合大小写 Video/QuickTime', 'Video/QuickTime');
  M('video-no-slash', 'video(无斜杠,前缀碰撞探测)', 'video');
  M('video-trailing', 'video/ 尾随斜杠', 'video/');
  M('video-space', 'video/mp4 带前后空格', '  video/mp4  ');
  M('video-junk-suffix', 'video/mp4; codecs="avc1"(带参数)', 'video/mp4; codecs="avc1.42E01E"');
  M('video-long', 'video/ + 5000 字符', 'video/' + 'x'.repeat(5000));
  M('video-newline', 'video/mp4\\n 注入换行', 'video/mp4\nX-Injected: 1');
  M('not-video', 'application/octet-stream(非视频)', 'application/octet-stream');
  M('empty', '空串', '');
  M('null', 'null(非字符串)', null);
  M('number', '数字 42(非字符串)', 42);
  M('object', '对象(非字符串)', { toString() { return 'video/mp4'; } });
  return cases;
}

module.exports = { V, bytes, be32, buildVideoCorpus, buildVideoMimeCorpus };
