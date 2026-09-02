/**
 * chalk <-> picocolors 链式兼容垫片。
 *
 * 背景:仓库 chalk→picocolors 迁移进行到一半 —— `services/backend/src/cli/**`
 * 已有 ~30 个文件 `require('picocolors')`,但调用方仍按 chalk 链式 API 写
 * (`chalk.cyan.bold(...)` / `chalk.red.bold(...)` / `chalk.hex('#...')` 等)。
 * picocolors 是扁平 API(无链式、无 hex),直接 require 会让所有 CLI 入口在
 * 第一次链式调用时抛 `chalk.cyan.bold is not a function`。
 *
 * 修法:在 backend 入口最早 require 本文件;本文件 require('picocolors') 并
 * 把 require 缓存里那一份替换成一个 Proxy,使得 `c.cyan.bold` 返回一个新的
 * 链式函数,实际执行时按 chalk 顺序把所有样式应用到输入串。
 *
 * 仅加兼容性方法(bold / dim / italic / underline / inverse / hidden /
 * strikethrough / hex / bgXxx) — 不删任何 picocolors 原生方法,所以下游
 * 直接用 `chalk.dim(...)` / `chalk.cyan(...)` 也不受影响。
 *
 * 失败模式:Proxy 异常一律降级为 String(str) 返回,绝不再次抛错导致循环
 * (上层 printError 自己也走 chalk 链式,二次崩 = 静默失败)。
 */
'use strict';

const Module = require('module');
const path = require('path');

const MODIFIER_NAMES = [
  'bold',
  'dim',
  'italic',
  'underline',
  'inverse',
  'hidden',
  'strikethrough',
  'reset',
];

// 像素级近似 chalk 链式:chalk 链从左到右,样式嵌套;我们用最简的「apply
// 顺序 = 调用顺序」——picocolors formatter 是 ANSI 开/闭,顺序套娃即可。
// 颜色与修饰都属"打开/关闭"码,只要不被重置(无 reset 链上)就能正确嵌套。
function _hexPairToAnsi(hex, openLead, closeLead) {
  const h = String(hex || '').trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(h)) {
    return null;
  }
  const full = h.length === 3
    ? h.split('').map((c) => c + c).join('')
    : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return { open: `\x1b[${openLead};2;${r};${g};${b}m`, close: `\x1b[${closeLead}m` };
}

// 256 色板显式前景(38)/背景(48),markdownRenderer 代码块底色 bgAnsi256(237) 等在用。
function _ansi256PairToAnsi(n, openLead, closeLead) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 0 || num > 255) {
    return null;
  }
  return { open: `\x1b[${openLead};5;${num}m`, close: `\x1b[${closeLead}m` };
}

function _rgbPairToAnsi(r, g, b, openLead, closeLead) {
  const ch = [r, g, b].map((v) => Number(v));
  if (ch.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
    return null;
  }
  return { open: `\x1b[${openLead};2;${ch[0]};${ch[1]};${ch[2]}m`, close: `\x1b[${closeLead}m` };
}

function _applyChain(pico, styleStack, input) {
  let out = String(input);
  for (const s of styleStack) {
    try {
      const fn = typeof s === 'string' ? pico[s] : s;
      if (typeof fn === 'function') {
        out = fn(out);
      } else if (s && s.open && s.close) {
        out = `${s.open}${out}${s.close}`;
      }
    } catch {
      /* 单步失败不阻断链; 仍应用剩余样式 */
    }
  }
  return out;
}

// 显式色板方法表:属性访问返回「传色值 → 新链」的方法。不支持颜色的环境
// (pico.isColorSupported === false)下退化为不含色板的同栈链(输出纯文本)。
const _STYLE_BUILDERS = {
  hex: (hex) => _hexPairToAnsi(hex, 38, 39),
  bgHex: (hex) => _hexPairToAnsi(hex, 48, 49),
  ansi256: (n) => _ansi256PairToAnsi(n, 38, 39),
  bgAnsi256: (n) => _ansi256PairToAnsi(n, 48, 49),
  rgb: (r, g, b) => _rgbPairToAnsi(r, g, b, 38, 39),
};

function _buildCompat() {
  // 强制从我们这里 require,避免被 require 缓存复用未包装的版本
  const pico = require('picocolors');

  // 是否样式属性:修饰词 / bg* 色名 / picocolors 原生样式函数
  function _isStyleProp(prop) {
    return (
      MODIFIER_NAMES.includes(prop) || /^bg?[A-Z]/.test(prop) || typeof pico[prop] === 'function'
    );
  }

  // 链式函数:每次访问属性 → 新增 style → 返回新链
  function makeChained(styleStack) {
    const fn = function (input) {
      return _applyChain(pico, styleStack, input);
    };
    return new Proxy(fn, {
      get(target, prop) {
        if (prop === Symbol.toPrimitive) {
          return () => 'chalk';
        }
        if (prop === 'toString' || prop === 'valueOf') {
          return () => 'chalk';
        }
        if (prop === Symbol.iterator) {
          return undefined;
        }
        if (typeof prop !== 'string') {
          return Reflect.get(target, prop);
        }
        // 显式色板方法必须先于普通样式合成:chalk 语义是「链.色板方法(色值) → 新链 →
        // (文本)」。若在这里被当普通样式合成,色值会被当成文本把链调用掉,返回字符串,
        // 再调文本时就抛 "c().bold.hex(...) is not a function"。
        const builder = _STYLE_BUILDERS[prop];
        if (builder) {
          return (...args) => {
            const pair = pico.isColorSupported === false ? null : builder(...args);
            return makeChained(pair ? styleStack.concat([pair]) : styleStack);
          };
        }
        if (!_isStyleProp(prop)) {
          // 自有非样式属性(如透传元数据)原样透出
          const own = Reflect.get(target, prop, target);
          if (own !== undefined) {
            return own;
          }
          // picocolors 元数据(isColorSupported 等)透传
          if (pico[prop] !== undefined) {
            return pico[prop];
          }
        }
        // 颜色 / 修饰:推入栈;未知属性返回 noop 链避免崩
        if (_isStyleProp(prop)) {
          return makeChained(styleStack.concat([prop]));
        }
        return makeChained(styleStack);
      },
    });
  }

  return makeChained([]);
}

let _installed = false;

function install() {
  if (_installed) {
    return;
  }
  _installed = true;

  // 找到 picocolors 已加载 / 待加载的模块记录,把它替换为兼容版。
  // 关键点:必须先强制 resolve 一次,确保 require 缓存里有它;
  // 然后整体替换 exports; 之后所有 require('picocolors') 都拿这一份。
  let resolvedPath = null;
  try {
    resolvedPath = require.resolve('picocolors');
  } catch {
    return; // 没装 picocolors 就什么都不做(直接走 chalk 也行,不会到这里)
  }

  const compat = _buildCompat();

  const existing = require.cache[resolvedPath];
  if (existing) {
    existing.exports = compat;
  } else {
    // 还没加载过:伪造一个最小 Module 记录,只填 exports; 后续 require 会复用它
    const stub = new Module(resolvedPath);
    stub.filename = resolvedPath;
    stub.loaded = true;
    stub.exports = compat;
    require.cache[resolvedPath] = stub;
  }
}

install();

module.exports = { install };
