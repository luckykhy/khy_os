'use strict';

/**
 * windsurfProtobuf — Windsurf 客户端模型配置的 protobuf 线编码原语
 * （从 gateway/proxyServer.js 抽出）。
 *
 * 抽出动机（[DESIGN-ARCH-051] 单人维护者驾驶舱「巨石预警」预防面驱动）：proxyServer.js
 * 逾 2500 行巨石阈值（R2 架构债）。本簇为**纯函数**——无 I/O、无模块状态闭包，仅按
 * Windsurf 私有 protobuf 结构把模型 id 列表编码为 `Buffer`，天然可独立成模块并单测，
 * 是降巨石的低风险切口。行为与抽出前**逐字节一致**：去重 `dedupeModels` 仍由调用方在
 * 传入前完成（原实现在 `encodeWindsurfModelConfigResponse` 内联 `dedupeModels(models)`，
 * 等价地上提到唯一调用点），本模块只承担「已定列表 → protobuf 字节」这一纯编码职责。
 */

/** 追加一个无符号 varint（base-128，最低位组在前）。 */
function appendVarint(buf, value) {
  let v = BigInt(Math.max(0, Number(value) || 0));
  while (v >= 0x80n) {
    buf.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  buf.push(Number(v));
}

/** 追加字段标签 = (fieldNum << 3) | wireType。 */
function appendTag(buf, fieldNum, wireType) {
  appendVarint(buf, (fieldNum << 3) | wireType);
}

/** 追加 length-delimited（wireType 2）字符串字段。 */
function appendStringField(buf, fieldNum, text) {
  const payload = Buffer.from(String(text || ''), 'utf8');
  appendTag(buf, fieldNum, 2);
  appendVarint(buf, payload.length);
  for (const b of payload) buf.push(b);
}

/** 追加 varint（wireType 0）布尔字段。 */
function appendBoolField(buf, fieldNum, flag) {
  appendTag(buf, fieldNum, 0);
  buf.push(flag ? 1 : 0);
}

/** 编码单个 client_model_config 子消息为 Buffer。 */
function encodeWindsurfClientModelConfig(modelId, recommended = false) {
  const msg = [];
  appendStringField(msg, 1, modelId); // label
  appendStringField(msg, 22, modelId); // model_uid
  if (recommended) appendBoolField(msg, 11, true); // is_recommended
  return Buffer.from(msg);
}

/**
 * 编码 repeated client_model_configs 响应为 Buffer。
 * @param {string[]} models 已去重的模型 id 列表（去重由调用方完成，见模块头注释）。
 */
function encodeWindsurfModelConfigResponse(models = []) {
  const out = [];
  const list = models;
  for (let i = 0; i < list.length; i += 1) {
    const inner = encodeWindsurfClientModelConfig(list[i], i === 0);
    appendTag(out, 1, 2); // repeated client_model_configs
    appendVarint(out, inner.length);
    for (const b of inner) out.push(b);
  }
  return Buffer.from(out);
}

module.exports = {
  appendVarint,
  appendTag,
  appendStringField,
  appendBoolField,
  encodeWindsurfClientModelConfig,
  encodeWindsurfModelConfigResponse,
};
