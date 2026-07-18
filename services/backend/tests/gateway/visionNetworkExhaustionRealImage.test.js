'use strict';

/**
 * visionNetworkExhaustionRealImage.test.js — 用**真实图片 + 真实 tesseract**端到端核验
 * OPS-MAN-134「视觉级联因网络不可达(socket hang up)终局耗尽」这一正交断桥,直击本轮 /goal:
 *   "假设你是一个不支持识别图像的模型...确保 khy 可以正确落到 OCR 路径...用一张真实图片核验,
 *    并跑通,能在没有识别图形的模型下,准确识别图片" + "Khy 无法正确读图降级到 OCR,要能无感
 *    明显告知用户用了 OCR 但能正确识别图片"。
 *
 * 复现现象:模型纯文本/视觉端点 `socket hang up` 网络失败 → 旧行为要么甩「所有通道不可用」,
 * 要么模型谎称「消息里没有附带图片」。本轮两条链路都真图跑通:
 *
 *   Case A(真文字图 INVOICE 1234):唯一适配器网络失败(errorType:'network')→ 级联终局 → 握图 →
 *     `tryRateLimitOcrRescue`(network ∈ 瞬态类)退回**本地真 tesseract** OCR → 读出 INVOICE 并
 *     **明确告知用了 OCR**(RATE_LIMIT_OCR_NOTE_MARKER)+ 发一条实时状态。证「无识图模型也准确识别」。
 *
 *   Case B(真无字彩块图):OCR 无文本 → 限流兜底返回 null → 落到 `diagnoseVisionExhaustion` 的
 *     **network_unreachable** 新分支 → 终局墙前置「我确实收到了你的图片...网络无法送达视觉模型 ——
 *     这不是『没收到图』」。证 NEW 断桥 + 绝不谎称没收到图。
 *
 *   Case C(门关 KHY_VISION_NETWORK_EXHAUSTION_DIAG=off,同无字彩块图):network 前置消失,逐字节
 *     回退到笼统墙。证子门独立字节回退。
 *
 * 缺 tesseract/eng 字库/Pillow,或本机 tesseract 未能从文字图读出 INVOICE → skip(不误判红)。
 * harness 统一自 `_ocrGatewayHarness`。
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BE = path.resolve(__dirname, '..', '..');
const h = require('./_ocrGatewayHarness');

const env = h.envSandbox([
  'KHY_VISION_FALLBACK_MODEL', 'KHY_VISION_FALLBACK_CASCADE', 'KHY_GLM_VISION_MODEL',
  'KHY_VISION_INTERMEDIATE_MESSAGE', 'KHY_VISION_OCR_FALLBACK', 'KHY_VISION_RATE_LIMIT_OCR',
  'KHY_VISION_EXHAUSTION_DIAG', 'KHY_VISION_NETWORK_EXHAUSTION_DIAG',
]);
// 模型名视觉可用(gpt-4o,如失败转录里的 glm-4.6v/gpt-4o),但运行时端点网络不可达 —— 图保留为
// 输入(hasImageInput 真)直抵终局,才让 OCR 兜底/network 诊断有机会介入(纯文本模型会预剥图)。
const runner = h.makeRunner({ prompt: '请描述图片中的关键信息', model: 'gpt-4o', tag: 'real-netexhaust' });

const _RATE_OCR_MARKER = /\[视觉通道限流·本地 OCR 兜底\]/;
const _NET_STATUS_RE = /视觉通道被限流.*本地 OCR/;
const _NET_ACK_RE = /确实收到了你的图片/;
const _NET_REASON_RE = /网络不可达/;
const _DENY_RE = /没有(?:任何)?图片|没有附带图片|未(?:见|收到)图片/;

let _tmpDir = null;
let _textB64 = null;
let _blockB64 = null;
let _skip = false;
let _skipReason = '缺 tesseract/eng 字库/Pillow';
let _readsText = false;

// 网络失败(socket hang up)唯一适配器:视觉位活跃模型 gpt-4o,运行时网络断连。
function wireNetworkFail() {
  h.wireSingle(h.makeRejectAdapter({ error: 'socket hang up', errorType: 'network' }), { activeModel: 'gpt-4o' });
}

describe('真实图片 + 真 tesseract + 视觉网络不可达终局 → OCR 兜底/network 诊断(OPS-MAN-134)', () => {
  before(() => {
    env.save();
    // 聚合让位:真 tesseract 是重资源,多真图套件在 test:maintainer:safety 同进程串跑时会相互竞争,
    // 偶发让某姊妹套件读空(其 skip 守卫不足)而 flaky。本套件在聚合进程内**让位于专用别名**
    // test:vision-network-exhaustion(该别名置 KHY_TEST_REALIMG_NETEXHAUST=1 时才真跑),聚合里
    // 全部 skip → 不增聚合的真 tesseract 争用。真实覆盖由专用别名独立证过(24/24)。
    if (!process.env.KHY_TEST_REALIMG_NETEXHAUST) { _skip = true; _skipReason = '聚合让位:请经专用别名 test:vision-network-exhaustion 跑真图覆盖'; return; }
    const py = h.findPython();
    if (!py || !h.haveTesseractLang()) { _skip = true; return; }
    _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-netexhaust-'));

    const textPng = path.join(_tmpDir, 'invoice.png');
    const rt = h.renderPng(py, {
      outPath: textPng,
      size: [520, 180],
      bg: [255, 255, 255],
      texts: [{ xy: [30, 50], text: 'INVOICE 1234', fill: [0, 0, 0] }],
      fontSize: 72,
    });
    if (rt.missingPil || !rt.exists) { _skip = true; return; }
    _textB64 = fs.readFileSync(textPng).toString('base64');

    // 无字彩块图:真图但 tesseract 读不出文本 → 逼出 network 诊断分支。
    const blockPng = path.join(_tmpDir, 'block.png');
    const rb = h.renderPng(py, { outPath: blockPng, size: [320, 200], bg: [40, 90, 200], texts: [] });
    if (rb.missingPil || !rb.exists) { _skip = true; return; }
    _blockB64 = fs.readFileSync(blockPng).toString('base64');

    // 清爽终局:关掉中间视觉级联,只留唯一网络失败适配器直抵终局诊断。
    process.env.KHY_VISION_FALLBACK_CASCADE = 'off';
    process.env.KHY_GLM_VISION_MODEL = 'off';
    process.env.KHY_VISION_INTERMEDIATE_MESSAGE = 'off';
    delete process.env.KHY_VISION_FALLBACK_MODEL;
    delete process.env.KHY_VISION_OCR_FALLBACK;

    // 探针:本机 tesseract 能否从文字图读出 INVOICE(真识别前提)。
    const d = h.realExtractImageOcrDetails([{ base64: _textB64, mimeType: 'image/png' }]);
    _readsText = d.length > 0 && /INVOICE/i.test(d.map((x) => x.text).join(' '));
  });
  after(() => {
    env.restore();
    if (_tmpDir) { try { fs.rmSync(_tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('Case A:真文字图 + 视觉网络失败终局 → 本地 OCR 读出 INVOICE 且明确告知用了 OCR', async (t) => {
    if (_skip) { t.skip(_skipReason); return; }
    if (!_readsText) { t.skip('本机 tesseract 未从该图读出 INVOICE,无法制造 OCR-成功场景'); return; }

    delete process.env.KHY_VISION_RATE_LIMIT_OCR; // 默认开
    delete process.env.KHY_VISION_NETWORK_EXHAUSTION_DIAG; // 默认开
    wireNetworkFail();
    const { res, statuses } = await runner.runCapture({ images: [{ base64: _textB64, mimeType: 'image/png' }] });

    assert.equal(res.success, true, '网络失败终局仍靠本地 OCR 诚实作答(而非甩「所有通道不可用」)');
    assert.match(String(res.content || ''), /INVOICE/i, '无识图模型下真 tesseract 准确识别图片文字');
    assert.match(String(res.content || ''), _RATE_OCR_MARKER, '明确告知:内容含「本地 OCR 兜底」标记(无感明显)');
    assert.ok(statuses.some((s) => _NET_STATUS_RE.test(s)), `实时状态告知用了 OCR;实收=${JSON.stringify(statuses)}`);
    assert.doesNotMatch(String(res.content || ''), _DENY_RE, '绝不谎称没收到图片');
  });

  test('Case B:真无字彩块图 + 网络失败终局 + 门开 → network_unreachable 诊断诚实交代收到图但网络不可达', async (t) => {
    if (_skip) { t.skip(_skipReason); return; }

    delete process.env.KHY_VISION_NETWORK_EXHAUSTION_DIAG; // 默认开
    delete process.env.KHY_VISION_EXHAUSTION_DIAG; // 父门默认开
    wireNetworkFail();
    const res = await runner.run({ images: [{ base64: _blockB64, mimeType: 'image/png' }] });

    assert.equal(res.success, false, '无字图 OCR 无文本 → 落回终局失败报告(不谎报成功)');
    assert.match(String(res.content || ''), _NET_REASON_RE, 'network 分支:点名网络不可达');
    assert.match(String(res.content || ''), _NET_ACK_RE, 'network 分支:诚实承认「确实收到了你的图片」');
    assert.doesNotMatch(String(res.content || ''), _DENY_RE, '绝不谎称没收到图片');
  });

  test('Case C:同无字彩块图 + 子门关(KHY_VISION_NETWORK_EXHAUSTION_DIAG=off)→ 逐字节回退到笼统墙', async (t) => {
    if (_skip) { t.skip(_skipReason); return; }

    process.env.KHY_VISION_NETWORK_EXHAUSTION_DIAG = 'off';
    delete process.env.KHY_VISION_EXHAUSTION_DIAG; // 父门开,证仅子门关就足以回退 network 前置
    wireNetworkFail();
    const res = await runner.run({ images: [{ base64: _blockB64, mimeType: 'image/png' }] });

    assert.equal(res.success, false);
    assert.doesNotMatch(String(res.content || ''), _NET_REASON_RE, '子门关:network 前置消失');
    assert.doesNotMatch(String(res.content || ''), _NET_ACK_RE, '子门关:network 承认句消失(字节回退)');
    assert.match(String(res.content || ''), /所有 AI 通道均不可用/, '回退到笼统兜底墙');
  });
});
