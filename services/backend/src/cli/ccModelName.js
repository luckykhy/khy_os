'use strict';

/**
 * ccModelName — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 * CC 屏幕上显示的模型名(页脚状态行、启动横幅)并不是把模型 id 裸贴上去,它背后
 * 是 CC 源码 `src/utils/model/model.ts` 的 `renderModelName(model)`:
 *   renderModelName(model):
 *     const publicName = getPublicModelDisplayName(model);
 *     if (publicName) return publicName;        // 命中 → 友好名 "Opus 4.6"
 *     return model;                             // 未命中 → 裸 model id 原样返回
 *   getPublicModelDisplayName(model): 一张 switch(model) 把完整模型 id 映成
 *     "Opus 4.7" / "Opus 4.6" / "Sonnet 4.6" / "Haiku 4.5" …;default → null。
 *     `[1m]` 变体追加 " (1M context)"。
 *   `src/components/BuiltinStatusLine.tsx:68`:再取**前两词** → "Opus 4.6"。
 *
 * 本叶子把 CC 那张 switch 映射**算法化**——CC 的 key 是命名常量,Khy 的模型 slug 是
 * 连字符约定(claude-<family>-<major>[-.<minor>]),逐条 switch 会随模型版本腐烂,
 * 所以改成对 Khy slug 约定的解析,得到同一种**派生**(id → friendly family+version;
 * 未知 → raw),适配 Khy slug 约定,而非逐字节复刻 CC 的 switch。
 *
 * **这是「模型身份显示名派生」的单一真源**:页脚(FooterBar)与启动横幅(classic
 * formatters.printBanner / TUI App.js welcome banner)都委托到这里,杜绝各处各写
 * 一套近似解析(那正是「显示对齐但后端逻辑没对齐」)。
 *
 * 门控 KHY_MODEL_DISPLAY_NAME(默认开)。=0/false/off/no → 关 → 逐字节回退裸 slug。
 */

const CAP = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

function modelDisplayNameEnabled(env = process.env) {
  const v = String((env && env.KHY_MODEL_DISPLAY_NAME) || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * 把模型 slug 派生成 CC 同款友好显示名("Opus 4.8" / "Sonnet 4.6" / "Haiku 4.5")。
 * 未命中(非 Claude / 任意 provider slug / 'auto' / 空)→ 原样返回(忠实对齐 CC null→raw)。
 *
 * 纯函数:零 IO、绝不抛、未知输入恒等返回。门控关 → 裸 slug 逐字节回退。
 *
 * @param {string} model
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function formatModelLabel(model, env = process.env) {
  const raw = String(model == null ? '' : model).trim();
  if (!raw) return '';
  if (!modelDisplayNameEnabled(env)) return raw;
  // New convention: claude-<family>-<major>[-.<minor>][-<suffix…>]
  // The minor group is bounded to 1–2 digits followed by end-or-separator so it
  // can NEVER swallow the 8-digit date suffix of a canonical Anthropic id
  // (e.g. `claude-opus-4-20250514` must render "Opus 4", not "Opus 4.20250514").
  let m = /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2})(?=$|[-.]))?/i.exec(raw);
  // Legacy convention: claude-<major>[-.<minor>]-<family>-<date>
  if (!m) {
    const lg = /^claude-(\d+)(?:[-.](\d+))?-(opus|sonnet|haiku)/i.exec(raw);
    if (lg) m = [lg[0], lg[3], lg[1], lg[2]];
  }
  if (!m) return raw; // CC parity: unknown model → raw id verbatim.
  const family = CAP[String(m[1]).toLowerCase()];
  const major = m[2];
  const minor = m[3];
  if (!family || major == null) return raw;
  return minor != null ? `${family} ${major}.${minor}` : `${family} ${major}`;
}

module.exports = {
  modelDisplayNameEnabled,
  formatModelLabel,
};
