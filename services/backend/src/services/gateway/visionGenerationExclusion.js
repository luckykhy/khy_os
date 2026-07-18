'use strict';

/**
 * visionGenerationExclusion.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 背景(真实 bug):visionCapability 的 `isVisionCapableModel` 用名字子串启发式,
 * 其中 VISION_NAME_HINTS 含裸片段 'image'。于是**图像生成模型**(名字带 image、
 * 只「生成图、不收图」)被误判为「支持视觉输入」——例如自定义 provider 的
 * `agnes-image-2.1-flash`。后果:纯文本模型(agnes-2.0-flash)收到图 →
 * decideVisionRouting 在同池兄弟里用 pickVisionCandidate 选中该生成型号 →
 * 自动改选 options.model=agnes-image-2.1-flash → 图像被发到**生成端点** →
 * 上游 `model_not_found` / 400 / 404(正是 auto::api 报的 404 现象)。
 *
 * 既有「修正」是精确 id 名单 BUILTIN_TEXT_ONLY_MODELS,但它只能逐个枚举
 * (当前仅两个 SenseNova id),**无法覆盖任意自定义 provider 的 *-image-* /
 * 视频生成型号**。本叶子把该纠正**模式化**:按「生成模型命名规律」识别
 * (图像生成 + 视频生成),让 visionCapability 在 name-hint 之前强制判其为纯文本
 * (不接受图像输入),从而不被选作视觉候选 → 退回 OCR / 诚实说明,绝不误发到生成端点。
 *
 * 判定范围**刻意收窄**为「媒体生成」型号(image / video 生成家族)——正是与视觉
 * 输入命名相撞的那一类;不含 audio/tts/embedding(它们本就不命中任何视觉提示、
 * 无从被误选,纳入只会扩大误伤面)。优先级低于用户 env KHY_VISION_MODELS(在
 * visionCapability 里先判、命中即 true),故任何误伤用户都可用 env 精确纠回。
 *
 * 门控 KHY_VISION_GENERATION_EXCLUSION(默认开):关(0/false/off/no)→
 * isGenerationOnlyModel 恒 false → visionCapability 这层完全静默 → 逐字节回退
 * 今日行为(image 片段照旧误判为视觉)。绝不抛:异常一律回退关门语义。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 生成模型命名规律(小写匹配)。每条对应「只生成媒体、不接受图像输入」的型号族。
// 用词边界/段边界收紧,避免误伤真视觉输入型号(它们由 vision/-vl/omni/gpt-4o/gemini/
// claude-3 及 glm/modern 叶子在更早处判定,不依赖这里)。
const GENERATION_PATTERNS = Object.freeze([
  // ── 图像生成 ──────────────────────────────────────────────────────────────
  // 'image' 作为独立段出现(前后为非字母):agnes-image-2.1-flash、*-flash-image、
  // image-01…。真视觉输入型号(gpt-4o / qwen-vl / glm-4v / claude-3 …)名字里不带
  // 独立 'image' 段,故不受影响。'imagen' 之类(image 后接字母)不被此条命中,单列于下。
  { name: 'image-segment', re: /(^|[^a-z])image([^a-z]|$)/ },
  { name: 'gpt-image', re: /gpt[\s._-]?image/ },
  { name: 'dall-e', re: /dall[\s._-]?e/ },
  { name: 'imagen', re: /(^|[^a-z])imagen(\b|[^a-z]|$)/ }, // Google Imagen(生成)
  { name: 'stable-diffusion', re: /stable[\s._-]?diffusion/ },
  { name: 'sdxl', re: /(^|[^a-z])sdxl(\b|[^a-z]|$)/ },
  { name: 'sd3', re: /(^|[^a-z])sd[\s._-]?3(\b|[^a-z]|$)/ },
  { name: 'flux', re: /(^|[^a-z])flux(\b|[^a-z]|$)/ },
  { name: 'kolors', re: /kolors/ },
  { name: 'seedream', re: /seedream/ },
  { name: 'seededit', re: /seededit/ },
  { name: 'cogview', re: /cogview/ },
  { name: 'wanx', re: /(^|[^a-z])wanx/ },      // 阿里通义万相(图像生成)
  { name: 'ideogram', re: /ideogram/ },
  { name: 'recraft', re: /recraft/ },
  { name: 'kandinsky', re: /kandinsky/ },
  { name: 'hidream', re: /hidream/ },
  { name: 'irag', re: /(^|[^a-z])irag(\b|[^a-z]|$)/ }, // 百度 iRAG(文生图)
  // ── 视频生成 ──────────────────────────────────────────────────────────────
  // 'video' 作为独立段。视频生成型号当前不命中任何视觉提示、暂不会被误选,收录属
  // 同类防御(未来若扩展提示词也不致误改道),对今日 pick 行为为无副作用的 no-op。
  { name: 'video-segment', re: /(^|[^a-z])video([^a-z]|$)/ },
  { name: 'sora', re: /(^|[^a-z])sora(\b|[^a-z]|$)/ },
  { name: 'veo', re: /(^|[^a-z])veo[\s._-]?\d/ },   // Google Veo 2/3
  { name: 'kling', re: /(^|[^a-z])kling/ },
  { name: 'cogvideo', re: /cogvideo/ },
  { name: 'hailuo', re: /hailuo/ },
  { name: 'seedance', re: /seedance/ },
  { name: 'ltx-video', re: /ltx[\s._-]?video/ },
]);

/**
 * 门控 KHY_VISION_GENERATION_EXCLUSION:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function visionGenerationExclusionEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_VISION_GENERATION_EXCLUSION;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 某 model id 是否是「只生成媒体、不接受图像输入」的生成型号(门控内模式判定,容忍
 * provider 前缀)。关门/异常 → 恒 false(逐字节回退,不影响既有判定)。
 * @param {string} model
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function isGenerationOnlyModel(model, env = process.env) {
  try {
    if (!visionGenerationExclusionEnabled(env)) return false;
    const m = String(model == null ? '' : model).trim().toLowerCase();
    if (!m) return false;
    for (const p of GENERATION_PATTERNS) {
      if (p.re.test(m)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 命中的规律名(供调试/描述;无命中或关门 → null)。
 * @param {string} model
 * @param {Record<string,string>} [env]
 * @returns {string|null}
 */
function matchedGenerationPattern(model, env = process.env) {
  try {
    if (!visionGenerationExclusionEnabled(env)) return null;
    const m = String(model == null ? '' : model).trim().toLowerCase();
    if (!m) return null;
    for (const p of GENERATION_PATTERNS) {
      if (p.re.test(m)) return p.name;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  GENERATION_PATTERNS,
  visionGenerationExclusionEnabled,
  isGenerationOnlyModel,
  matchedGenerationPattern,
};
