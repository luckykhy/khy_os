'use strict';

/**
 * desktopControl/voiceBridge.js — 嘴 + 耳（DESIGN-ARCH-056）。
 *
 * 「眼/手」是本子系统新造的能力；「嘴（TTS）/耳（STT）」早已存在于 voiceService。
 * 本桥把它们薄薄地纳入统一的桌面操控面，使 DesktopController 一个门面就涵盖四感官，
 * **绝不重造** TTS/STT——只做适配与一致化的返回结构。
 *
 * voiceService 可注入，便于无音频设备的环境下单测。
 */

function _voice(deps) {
  return deps.voiceService || require('../voiceService');
}

/** 嘴：把文本读出来。返回 { success, handle? }——handle.cancel() 可打断。 */
function speak(text, options = {}, deps = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { success: false, error: '朗读文本必须为非空字符串。' };
  }
  try {
    const handle = _voice(deps).speak(text, options);
    return { success: true, handle, note: '已开始朗读（异步，不阻塞）。' };
  } catch (err) {
    return { success: false, error: `TTS 失败：${(err && err.message) || String(err)}` };
  }
}

/** 停止朗读。 */
function stopSpeaking(deps = {}) {
  try { _voice(deps).stopSpeaking(); return { success: true }; }
  catch (err) { return { success: false, error: (err && err.message) || String(err) }; }
}

/** 耳：录音并转写为文本。 */
async function listen(options = {}, deps = {}) {
  try {
    const res = await _voice(deps).listen(options);
    if (res && res.error) return { success: false, error: res.error };
    return { success: true, text: (res && res.text) || '', duration: (res && res.duration) || 0 };
  } catch (err) {
    return { success: false, error: `STT 失败：${(err && err.message) || String(err)}` };
  }
}

/** 嘴/耳能力快照。 */
function capabilities(deps = {}) {
  try {
    const caps = _voice(deps).getCapabilities();
    return {
      mouth: { available: !!(caps && caps.tts), provider: (caps && caps.tts) || null },
      ears: { available: !!(caps && caps.stt), provider: (caps && caps.stt) || null },
    };
  } catch {
    return { mouth: { available: false, provider: null }, ears: { available: false, provider: null } };
  }
}

module.exports = { speak, stopSpeaking, listen, capabilities };
