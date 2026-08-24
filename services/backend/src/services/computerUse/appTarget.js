'use strict';

/**
 * computerUse/appTarget.js — Computer Use 目标应用识别（对应 Codex 的 @应用名 语法）。
 *
 * 从用户的自然语言目标中解析出「要在哪个应用里操作」。支持两种写法：
 *   1. 显式 @应用名 前缀：`@Firefox 打开书签` / `@微信 给张三发消息`
 *   2. 隐式应用名：`打开微信发消息` → 识别出「微信」
 *
 * 内置一张常见应用映射表（中文/英文名 → 窗口匹配名），覆盖高频桌面应用：
 * 微信 / QQ / 浏览器(Firefox/Chrome/Edge) / Office(Word/Excel/PPT/Outlook) /
 * 记事本 / 计算器 / VS Code / IDEA / 终端 / 文件资源管理器 等。
 *
 * 纯函数、零 IO、绝不抛：任何输入都返回确定结果，不做系统调用。
 * 真正的窗口探测（listWindows 匹配）由调用方在应用名解析后执行。
 */

// ── 应用映射表：常见名/别名 → 规范窗口匹配名 ────────────────────────────
// 数组形式允许一个应用多个别名；匹配按「用户文本包含别名」判定。
const APP_ALIASES = [
  { name: '微信', keys: ['微信', 'wechat', 'weixin', 'WeChat'] },
  { name: 'QQ', keys: ['qq', 'QQ', '腾讯QQ'] },
  { name: 'Firefox', keys: ['firefox', '火狐', '火狐浏览器'] },
  {
    name: 'Chrome',
    keys: [
      'chrome',
      '谷歌浏览器',
      'google chrome',
      'chromium',
      '浏览器',
      'browser',
      '网页',
      '网页浏览器',
    ],
  },
  { name: 'Edge', keys: ['edge', '微软edge', 'microsoft edge'] },
  { name: 'Word', keys: ['word', '微软word', 'microsoft word'] },
  { name: 'Excel', keys: ['excel', 'microsoft excel'] },
  { name: 'PowerPoint', keys: ['powerpoint', 'ppt', '幻灯片', 'microsoft powerpoint'] },
  { name: 'Outlook', keys: ['outlook', '邮箱客户端', '邮件客户端', '邮件', '邮箱'] },
  { name: '记事本', keys: ['记事本', 'notepad', 'notepad.exe'] },
  { name: '计算器', keys: ['计算器', 'calculator', 'calc'] },
  { name: 'VS Code', keys: ['vs code', 'vscode', 'visual studio code', '代码编辑器'] },
  { name: 'IntelliJ IDEA', keys: ['idea', 'intellij', 'intellij idea'] },
  { name: 'PyCharm', keys: ['pycharm', 'python编辑器'] },
  { name: '终端', keys: ['终端', 'terminal', 'powershell', 'cmd', '命令提示符', '命令窗口'] },
  {
    name: '文件资源管理器',
    keys: ['文件资源管理器', '资源管理器', 'explorer', '文件夹', '我的电脑', '此电脑'],
  },
  { name: '画图', keys: ['画图', 'mspaint', 'paint'] },
  { name: '播放器', keys: ['播放器', 'media player', 'potplayer'] },
  { name: 'Steam', keys: ['steam', '蒸汽平台'] },
  { name: '钉钉', keys: ['钉钉', 'dingtalk'] },
  { name: '企业微信', keys: ['企业微信', 'wecom', 'work wechat'] },
  { name: '腾讯会议', keys: ['腾讯会议', 'tencent meeting', 'vooov'] },
  { name: '网易云音乐', keys: ['网易云音乐', 'netease cloud music', '云音乐'] },
  { name: 'QQ音乐', keys: ['qq音乐', 'qq music'] },
  { name: 'PotPlayer', keys: ['potplayer', 'pot player'] },
  // ── 系统自带小应用 ────────────────────────────────────────────────────
  // 跨应用生活类任务（行程规划、日程安排、清单整理）几乎全落在这一组上；
  // 缺了它们，resolveTargetApps 只能识别出「浏览器」一个应用，
  // 决策提示词里的「跨应用协作」段就不会触发。
  {
    name: '备忘录',
    keys: ['备忘录', '便签', '便笺', '便利贴', 'notes', 'sticky notes', 'stickynotes', '记事'],
  },
  { name: '日历', keys: ['日历', '日程表', '日程', 'calendar'] },
  {
    name: '地图',
    keys: ['地图', 'maps', '高德地图', '百度地图', '腾讯地图', 'amap', 'gaode', 'google maps'],
  },
  { name: '待办', keys: ['待办', '待办事项', 'to do', 'todo', 'microsoft to do', 'reminders'] },
  { name: '时钟', keys: ['时钟', '闹钟', '秒表', '计时器', 'clock', 'alarm'] },
  { name: '天气', keys: ['天气', 'weather'] },
  { name: '照片', keys: ['照片', '相册', '图片查看器', 'photos', 'photo viewer'] },
  { name: '相机', keys: ['相机', '摄像头', 'camera'] },
  // '设置' 单字太泛（「设置提醒时间」会误命中），只认长写法与英文名。
  { name: '设置', keys: ['系统设置', '设置应用', 'settings', '控制面板', 'control panel'] },
];

// 归一化：小写、去空白、统一全半角
function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)); // 全角→半角
}

/**
 * 从目标文本中解析 @应用名 显式语法。
 * @param {string} goal
 * @returns {{ ok:boolean, app?:string, rest?:string }} app 为规范名，rest 为去除 @app 前缀后的剩余目标
 */
function parseAtApp(goal) {
  const text = String(goal || '').trim();
  // @应用名 支持：@Firefox / @微信 / @Firefox 打开书签
  const m = text.match(/^\s*@([^\s@\u4e00-\u9fa5]{1,30}|[\u4e00-\u9fa5]{1,10})\s*(.*)$/s);
  if (!m) {
    return { ok: false };
  }
  const raw = m[1].trim();
  const rest = (m[2] || '').trim();
  // 把别名归一化为规范名
  const canonical = _canonicalApp(raw);
  return { ok: true, app: canonical || raw, rest };
}

/**
 * 把别名/原始名归一化为映射表中的规范名（找不到则原样返回）。
 * @param {string} raw
 * @returns {string}
 */
function _canonicalApp(raw) {
  const r = _norm(raw);
  for (const entry of APP_ALIASES) {
    for (const k of entry.keys) {
      if (r === _norm(k) || r.includes(_norm(k))) {
        return entry.name;
      }
    }
  }
  return String(raw || '').trim();
}

/**
 * 从自然语言目标中识别隐式目标应用。
 * 规则：
 *   - 若已有显式 @app，直接返回
 *   - 在目标文本中查找映射表别名命中
 *   - 命中多个时按首次出现顺序返回第一个（可配 prefer）
 * @param {string} goal
 * @param {object} [opts] { explicitApp?:string }
 * @returns {{ app: string|null, matched: string|null }}
 */
function resolveTargetApp(goal, opts = {}) {
  if (opts && opts.explicitApp) {
    return { app: String(opts.explicitApp).trim(), matched: null };
  }
  const text = String(goal || '').trim();
  if (!text) {
    return { app: null, matched: null };
  }

  // 先尝试 @应用名 显式语法
  const at = parseAtApp(text);
  if (at.ok && at.app) {
    return { app: at.app, matched: at.app };
  }

  const apps = _extractAllApps(text);
  if (apps.length > 0) {
    return { app: apps[0].name, matched: apps[0].matched };
  }
  return { app: null, matched: null };
}

/**
 * 从目标中提取【全部】命中的应用（跨应用协作的核心）。
 * 与 resolveTargetApp 不同：不提前返回，收集目标文本里出现的所有应用，
 * 按出现顺序去重。支持：
 *   - 显式 @应用名（多个：`@Chrome 复制报价到 @Excel`）
 *   - 隐式应用名（`从 Chrome 复制报价到 Excel` → [Chrome, Excel]）
 *
 * @param {string} goal
 * @returns {Array<{ name:string, matched:string, at:boolean }>} 按出现顺序去重
 */
function resolveTargetApps(goal) {
  const text = String(goal || '').trim();
  if (!text) {
    return [];
  }
  const out = [];
  const seen = new Set();

  const push = (name, matched, at) => {
    if (!name) {
      return;
    }
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    out.push({ name, matched, at: !!at });
  };

  // 1) 显式 @应用名（可多个）：@Chrome ... @Excel ...
  const atRe = /@([^\s@，。,.!?]{1,30}|[\u4e00-\u9fa5]{1,10})/g;
  let m;
  while ((m = atRe.exec(text)) !== null) {
    const raw = m[1].trim();
    push(_canonicalApp(raw) || raw, raw, true);
  }

  // 2) 隐式应用名：扫描映射表，收集所有命中的应用（按首次出现位置排序）。
  //    处理重叠别名：同一文本区间被更长的别名覆盖时，保留最长者（如"火狐浏览器"
  //    ⊇"浏览器"，只记 Firefox 不记 Chrome）。
  const norm = _norm(text);
  const implicitHits = [];
  for (const entry of APP_ALIASES) {
    let best = null; // { nk, idx, len }
    for (const k of entry.keys) {
      const nk = _norm(k);
      const idx = norm.indexOf(nk);
      if (idx >= 0 && (!best || nk.length > best.len)) {
        best = { nk, idx, len: nk.length };
      }
    }
    if (best) {
      implicitHits.push({
        name: entry.name,
        matched: best.nk,
        idx: best.idx,
        end: best.idx + best.len,
        len: best.len,
      });
    }
  }
  // 按出现位置排序；重叠区间（前一个区间覆盖后一个）只保留更长的。
  implicitHits.sort((a, b) => a.idx - b.idx || b.len - a.len);
  const kept = [];
  for (const hit of implicitHits) {
    const covered = kept.some((k) => k.idx <= hit.idx && hit.end <= k.end);
    if (!covered) {
      kept.push(hit);
    }
  }
  for (const hit of kept) {
    push(hit.name, hit.matched, false);
  }

  return out;
}

/**
 * 提取单个目标文本中命中的所有应用（内部辅助，按出现顺序）。
 * @returns {Array<{ name:string, matched:string }>}
 */
function _extractAllApps(text) {
  return resolveTargetApps(text).map((a) => ({ name: a.name, matched: a.matched }));
}

/**
 * 内置应用映射表（供诊断/测试）。
 */
function appCatalog() {
  return APP_ALIASES.map((e) => ({ name: e.name, aliases: e.keys.slice() }));
}

module.exports = {
  resolveTargetApp,
  resolveTargetApps,
  parseAtApp,
  appCatalog,
  _internals: { _norm, _canonicalApp, _extractAllApps },
};
