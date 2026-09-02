// 本地工具：独立模式（手机直连 AI 供应商）下，AI 可以调起来让手机「动手」。
// 工具调用是 OpenAI 格式：每个工具 = {name, description, parameters, execute(args)}。
// execute 返回字符串，作为 role:tool 的 content 回填给模型。

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';

// 工具注册表：每个工具声明 + 执行器。
// 命名空间 khy.local.* 是保留前缀，便于和远端 MCP 工具区分。
const TOOLS = [
  {
    name: 'khy.local.openUrl',
    description: '在系统浏览器中打开一个 URL（http/https）。不依赖 Shizuku。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整 URL' },
      },
      required: ['url'],
    },
    async execute({ url }) {
      if (!/^https?:\/\//i.test(url)) return `错误：只支持 http(s)，收到：${url}`;
      try {
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (opened) return `已请求打开：${url}`;
      } catch { /* 继续走 fallback */ }
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      document.body.appendChild(a); a.click(); a.remove();
      return `已请求打开：${url}`;
    },
  },
  {
    name: 'khy.local.readClipboard',
    description: '读取剪贴板中的纯文本内容。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const text = await navigator.clipboard.readText();
        return text || '（剪贴板为空）';
      } catch (cause) {
        return `读取失败：${cause.message || cause}（WebView 可能要求用户授权）`;
      }
    },
  },
  {
    name: 'khy.local.writeClipboard',
    description: '把一段文本写入系统剪贴板。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要写入剪贴板的文本' },
      },
      required: ['text'],
    },
    async execute({ text }) {
      try {
        await navigator.clipboard.writeText(String(text || ''));
        return `已写入 ${String(text || '').length} 字符到剪贴板`;
      } catch (cause) {
        return `写入失败：${cause.message || cause}`;
      }
    },
  },
  {
    name: 'khy.local.getAppInfo',
    description: '读取当前 App 的版本号、构建号、包名、运行平台。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      if (!Capacitor.isNativePlatform()) {
        return JSON.stringify({ platform: 'web', note: '当前运行在浏览器中' });
      }
      const info = await App.getInfo();
      return JSON.stringify({
        id: info.id,
        name: info.name,
        version: info.version,
        build: info.build,
        platform: Capacitor.getPlatform(),
      });
    },
  },
  {
    name: 'khy.local.openApp',
    description: '通过包名打开另一个 Android App。',
    parameters: {
      type: 'object',
      properties: {
        package: { type: 'string', description: '目标 App 的 Android 包名，如 com.tencent.mm' },
      },
      required: ['package'],
    },
    async execute({ package: pkg }) {
      if (!Capacitor.isNativePlatform()) return '错误：openApp 仅在 Android 设备上可用';
      // Capacitor 没有 launchByPackage；用 Intent 通过 App.openUrl 走 market scheme
      try {
        await App.openUrl({ url: `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${encodeURIComponent(pkg)};end` });
        return `已请求启动：${pkg}`;
      } catch (cause) {
        return `启动失败：${cause.message || cause}`;
      }
    },
  },
  {
    name: 'khy.local.searchNotes',
    description: '在 App 私有空间（khy_notes）的笔记里做关键字搜索。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键字' },
        limit: { type: 'integer', description: '返回条数上限', default: 10 },
      },
      required: ['query'],
    },
    async execute({ query, limit = 10 }) {
      // 笔记存在 Preferences 里 key = khy_note_<id>，value = JSON {title, body, updatedAt}
      const { keys } = await Preferences.keys();
      const noteKeys = keys.filter((k) => k.startsWith('khy_note_'));
      const results = [];
      for (const key of noteKeys) {
        const { value } = await Preferences.get({ key });
        if (!value) continue;
        try {
          const note = JSON.parse(value);
          if (note.title?.includes(query) || note.body?.includes(query)) {
            results.push({ id: key.replace('khy_note_', ''), title: note.title, snippet: (note.body || '').slice(0, 200), updatedAt: note.updatedAt });
            if (results.length >= limit) break;
          }
        } catch { /* skip bad entry */ }
      }
      return JSON.stringify({ query, count: results.length, results });
    },
  },
  {
    name: 'khy.local.calculator',
    description: '计算一个 JS 算术表达式（仅数字 + +-*/().%）。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '如 (1+2)*3' } },
      required: ['expression'],
    },
    async execute({ expression }) {
      const safe = String(expression || '').trim();
      if (!/^[\d+\-*/().\s%]+$/.test(safe)) {
        return `错误：表达式含不允许字符：${safe}`;
      }
      try {
        // eslint-disable-next-line no-new-func
        const value = Function(`"use strict"; return (${safe});`)();
        return `${safe} = ${value}`;
      } catch (cause) {
        return `计算失败：${cause.message || cause}`;
      }
    },
  },
  {
    name: 'khy.local.lookScreen',
    description: '截取当前手机屏幕（已开启看屏服务时静默；否则弹一次系统授权窗）+ 读 UI 树 → VLM 同时收到图和结构化文本。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '附加指令（可选），如"列出屏幕上的按钮"或"提取主要文字"' },
      },
    },
    async execute({ prompt }) {
      const { captureFrame, captureOnce, isShareReady, startShare } = await import('./screenCapture.js');
      const { getVlmSelection, getVlmApiKey, visionDescribe } = await import('./visionProvider.js');
      const sel = await getVlmSelection();
      if (!sel?.provider) return '错误：未配置视觉模型。请在「设置 → 视觉模型」里选 provider + 填 API Key。';
      const apiKey = await getVlmApiKey(sel.provider);
      if (!apiKey) return '错误：该 Vision Provider 没配 API Key';

      // 1) 抓屏：服务优先；服务未启时尝试启一次（首次必须用户点授权）
      let dataUrl = null;
      let width = 0, height = 0;
      if (await isShareReady()) {
        const r = await captureFrame();
        dataUrl = r?.dataUrl;
        width = r?.width || 0; height = r?.height || 0;
      } else {
        try {
          await startShare();
          const r = await captureFrame();
          dataUrl = r?.dataUrl;
          width = r?.width || 0; height = r?.height || 0;
        } catch (cause) {
          try { dataUrl = await captureOnce(); } catch (err) { return `错误：抓屏失败：${err.message || err}（用户也可能取消了授权）`; }
        }
      }
      if (!dataUrl) return '错误：抓屏失败——服务没起来或没拿到帧';

      // 2) 读 UI 树（无障碍在线时拿结构化文本；否则跳过）
      let uiTree = '';
      try {
        const { registerPlugin } = await import('@capacitor/core');
        const DeviceControl = registerPlugin('DeviceControl');
        const r = await DeviceControl.dumpUi();
        uiTree = r?.dump || '';
      } catch { /* 无障碍未授权 → 跳过 */ }

      // 3) 调 VLM：图 + UI 树双驱动
      const basePrompt = prompt || '请用中文描述这张手机屏幕截图：主要文字、按钮、当前所在页面、可见的菜单/列表项。';
      const fullPrompt = uiTree
        ? basePrompt + `\n\n以下是当前屏幕的 UI 元素结构（text=文本 desc=描述 id=资源ID class=类名），请结合图像一并参考：\n${uiTree}\n`
        : basePrompt + '\n\n（提示：无障碍服务未授权，无法拿到 UI 树，仅根据图像判断）\n';
      try {
        const description = await visionDescribe({
          provider: sel.provider, model: sel.model, apiKey,
          image: { dataUrl },
          prompt: fullPrompt,
        });
        return `[屏幕 ${width}x${height}] ${description}` + (uiTree ? '\n（参考：UI 树已发给 VLM，元素 ID 可直接用于 findAndClick）' : '');
        return `[屏幕] ${description}`;
      } catch (cause) {
        return `错误：VLM 描述失败：${cause.message || cause}`;
      }
    },
  },
  {
    name: 'khy.local.startScreenShare',
    description: '开启"看屏模式"前台服务——首次会弹一次系统授权窗，之后所有 lookScreen 静默截屏。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const { startShare } = await import('./screenCapture.js');
        const r = await startShare();
        return r?.ready ? '已开启看屏模式。后续 lookScreen 不再弹窗。' : '看屏服务启动中…';
      } catch (cause) {
        return `错误：${cause.message || cause}（用户可能取消了授权）`;
      }
    },
  },
  {
    name: 'khy.local.recordScreen',
    description: '在指定时间窗内连截 N 张屏幕（默认 3 张 / 1 秒），用 VLM 描述每帧内容与变化。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '截多少张（默认 3，最多 20）', default: 3 },
        intervalMs: { type: 'integer', description: '每张间隔毫秒（默认 1000，最小 200）', default: 1000 },
        prompt: { type: 'string', description: '附加指令（可选），如"看 App 列表是否在变化"或"用户在做什么动作"' },
      },
    },
    async execute({ count = 3, intervalMs = 1000, prompt }) {
      const { captureFrames, isShareReady, startShare } = await import('./screenCapture.js');
      const { getVlmSelection, getVlmApiKey, visionDescribe } = await import('./visionProvider.js');
      const sel = await getVlmSelection();
      if (!sel?.provider) return '错误：未配置视觉模型。请在「设置 → 视觉模型」里选 provider + 填 API Key。';
      const apiKey = await getVlmApiKey(sel.provider);
      if (!apiKey) return '错误：该 Vision Provider 没配 API Key';

      // 1) 抓多帧
      let frames = [];
      if (await isShareReady()) {
        const r = await captureFrames(count, intervalMs);
        frames = r.frames || [];
      } else {
        try {
          await startShare();
          const r = await captureFrames(count, intervalMs);
          frames = r.frames || [];
        } catch (cause) {
          return `错误：抓屏失败：${cause.message || cause}`;
        }
      }
      if (frames.length === 0) return '错误：未抓到任何帧';

      // 2) 让 VLM 看图——用同一张图对每张独立问"这帧是什么"，最后让 AI 自己对比
      //    为避免超大 payload（多张 base64），单帧 < 1280，3 张大约 1-2MB 在 token 预算内
      const perFrame = [];
      for (let i = 0; i < frames.length; i++) {
        try {
          const desc = await visionDescribe({
            provider: sel.provider, model: sel.model, apiKey,
            image: { dataUrl: 'data:image/jpeg;base64,' + frames[i] },
            prompt: prompt
              ? `${prompt}（这是第 ${i + 1}/${frames.length} 帧，相邻 ${intervalMs} 毫秒）`
              : `用中文简短描述这帧屏幕内容（第 ${i + 1}/${frames.length} 帧）。`,
          });
          perFrame.push({ index: i + 1, desc });
        } catch (cause) {
          perFrame.push({ index: i + 1, desc: `[VLM 失败: ${cause.message || cause}]` });
        }
      }
      // 3) 把每帧描述按时间序列返回；让上层 AI 自己看变化
      return `[录屏 ${frames.length} 帧 / 间隔 ${intervalMs}ms]\n` +
        perFrame.map((p) => `#${p.index} ${p.desc}`).join('\n');
    },
  },
  {
    name: 'khy.local.stopScreenShare',
    description: '关闭"看屏模式"前台服务。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const { stopShare } = await import('./screenCapture.js');
        await stopShare();
        return '看屏模式已关闭。';
      } catch (cause) {
        return `错误：${cause.message || cause}`;
      }
    },
  },
  {
    name: 'khy.local.understandImage',
    description: '让用户从相册选一张图，用视觉模型描述内容。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '附加指令（可选）' },
      },
    },
    async execute({ prompt }) {
      const { pickImage } = await import('./imagePicker.js');
      const result = await pickImage();
      if (!result) return '__PENDING_IMAGE_CANCELLED__';
      if (result.error) return `错误：选图失败：${result.error}`;
      const { getVlmSelection, getVlmApiKey, visionDescribe } = await import('./visionProvider.js');
      const sel = await getVlmSelection();
      if (!sel?.provider) return '错误：未配置视觉模型。请在「设置 → 视觉模型」里选 provider + 填 API Key。';
      const apiKey = await getVlmApiKey(sel.provider);
      if (!apiKey) return '错误：该 Vision Provider 没配 API Key';
      try {
        const description = await visionDescribe({
          provider: sel.provider, model: sel.model, apiKey,
          image: { dataUrl: result },
          prompt: prompt || '请用中文描述这张图。',
        });
        return `[图片] ${description}`;
      } catch (cause) {
        return `错误：VLM 描述失败：${cause.message || cause}`;
      }
    },
  },
  {
    name: 'khy.local.runProgram',
    description: '执行手机本地一个已安装的小程序（khy.program）。参数：name + 可选 args。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '小程序 id，对应 programs 列表中的 name' },
        args: { type: 'object', description: '传给小程序 steps 的变量映射', additionalProperties: true },
      },
      required: ['name'],
    },
    async execute({ name, args }) {
      const { value } = await Preferences.get({ key: `khy_program_${name}` });
      if (!value) return `错误：未找到小程序「${name}」，请先在「小程序」页面安装。`;
      const program = JSON.parse(value);
      const { runProgram } = await import('./programRuntime.js');
      return runProgram(program, args || {});
    },
  },
  {
    name: 'khy.local.openAppByName',
    description: '按 App 名称（中文/拼音/包名）启动已安装的应用。需先装 Shizuku 并授权。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App 名称（如「微信」「taobao」「高德」）或包名' },
      },
      required: ['name'],
    },
    async execute({ name }) {
      try {
        const { isShizukuReady, listApps, startActivity } = await import('./deviceControl.js');
        const ready = await isShizukuReady();
        if (!ready.ready) {
          return `错误：Shizuku 不可用（${ready.reason}）。需要 Shizuku App 启动并授权本 App。`;
        }
        const r = await listApps(name);
        const apps = (r && r.apps) || [];
        if (!apps.length) return `未找到名称包含「${name}」的应用`;
        // 选最像的一个（首条已按相关度排过）
        const target = apps[0];
        await startActivity(target.package);
        return `已启动：${target.label}（${target.package}）`;
      } catch (cause) {
        return `错误：${cause.message || cause}`;
      }
    },
  },
  {
    name: 'khy.local.tap',
    description: '在屏幕坐标 (x, y) 点击。需 Shizuku 已授权。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'X 坐标' },
        y: { type: 'integer', description: 'Y 坐标' },
      },
      required: ['x', 'y'],
    },
    async execute({ x, y }) {
      try {
        const { isShizukuReady, inputTap } = await import('./deviceControl.js');
        const ready = await isShizukuReady();
        if (!ready.ready) return `错误：Shizuku 不可用（${ready.reason}）`;
        await inputTap(x, y);
        return `已点击 (${x}, ${y})`;
      } catch (cause) { return `错误：${cause.message || cause}`; }
    },
  },
  {
    name: 'khy.local.swipe',
    description: '从 (x1,y1) 滑到 (x2,y2)，durationMs 默认 300。需 Shizuku 已授权。',
    parameters: {
      type: 'object',
      properties: {
        x1: { type: 'integer' }, y1: { type: 'integer' },
        x2: { type: 'integer' }, y2: { type: 'integer' },
        durationMs: { type: 'integer', description: '滑动时长（毫秒），默认 300', default: 300 },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
    async execute({ x1, y1, x2, y2, durationMs = 300 }) {
      try {
        const { isShizukuReady, inputSwipe } = await import('./deviceControl.js');
        const ready = await isShizukuReady();
        if (!ready.ready) return `错误：Shizuku 不可用（${ready.reason}）`;
        await inputSwipe(x1, y1, x2, y2, durationMs);
        return `已滑动 (${x1},${y1})→(${x2},${y2})`;
      } catch (cause) { return `错误：${cause.message || cause}`; }
    },
  },
  {
    name: 'khy.local.typeText',
    description: '在当前焦点的输入框里输入文字。需 Shizuku 已授权。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要输入的文字' } },
      required: ['text'],
    },
    async execute({ text }) {
      try {
        const { isShizukuReady, inputText } = await import('./deviceControl.js');
        const ready = await isShizukuReady();
        if (!ready.ready) return `错误：Shizuku 不可用（${ready.reason}）`;
        await inputText(text);
        return `已输入 ${text.length} 字符`;
      } catch (cause) { return `错误：${cause.message || cause}`; }
    },
  },
  {
    name: 'khy.local.runSkill',
    description: '执行手机本地一个已安装的 Skill（khy.skill）。比小程序更"软"——通常只是一组 description + steps 的可复用 prompt 流程。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill id，对应 skills 列表中的 name' },
        args: { type: 'object', description: '传给 Skill steps 的变量', additionalProperties: true },
      },
      required: ['name'],
    },
    async execute({ name, args }) {
      const { runSkill } = await import('./programRuntime.js');
      return runSkill(name, args || {});
    },
  },
  {
    name: 'khy.local.listSkills',
    description: '列出手机里已安装的 Skill 名称 + 一句话描述，便于 AI 决定要不要跳。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const { listSkills } = await import('./programRuntime.js');
      const skills = await listSkills();
      return JSON.stringify(skills.map((s) => ({ name: s.name, label: s.label, description: s.description })), null, 2);
    },
  },
  // ===== 无障碍混合模式：找元素→拿坐标 或 列出所有可点节点 =====
  {
    // 给 Agent "看 UI 树 + 用 text 找元素" 的混合模式：
    //   - 元素索引模式：khy.local.findAndClick（已存在）—— 走 AccessibilityService 节点 click
    //   - 坐标模式：khy.local.findAndTap —— 走 findWithBounds 拿中心 → input tap
    // Agent 默认走索引模式；拿不到/不可点时退回坐标模式（双坐标系闭环）。
    //
    // 强制重 find（forceRefresh）：每次执行前先调一次 khy.local.lookScreen + 等 UI 稳定，
    // 防止"屏幕已变但坐标缓存还在"导致点错地方。Agent 长任务时一定要 forceRefresh=true。
    name: 'khy.local.findAndTap',
    description: '按文字/ID/class 找元素，拿其中心屏幕坐标后点击。比 findAndClick 更稳（兜底用坐标）。需无障碍授权。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询字符串，如"搜索框""美团""id=com.meituan:id/btn"' },
        fallbackToCoord: { type: 'boolean', description: '如果节点 click 失败，是否自动用坐标 tap 兜底（默认 true）', default: true },
        forceRefresh: { type: 'boolean', description: '执行前先 lookScreen 刷新一次（防止坐标过期，默认 true）', default: true },
        settleMs: { type: 'integer', description: '刷新后等待 UI 稳定毫秒（默认 400）', default: 400 },
      },
      required: ['query'],
    },
    async execute({ query, fallbackToCoord = true, forceRefresh = true, settleMs = 400 }) {
      try {
        const { findWithBounds, findAndClick, inputTap, isShizukuReady } = await import('./deviceControl.js');
        // 0) 强制重 find：先看屏，让 UI 树最新
        if (forceRefresh) {
          try {
            const { lookScreen } = await import('./localTools.js').catch(() => ({}));
            // 不能递归调自己；只跑 lookScreen 这一步
            if (lookScreen) await lookScreen({ prompt: '刷新 UI 树' });
            // 等待 UI 稳定（页面切换、动画等）
            await new Promise((r) => setTimeout(r, Math.max(100, Math.min(2000, Number(settleMs) || 400))));
          } catch { /* 刷新失败不阻塞主流程 */ }
        }
        // 1) 拿坐标（必须是刷新后的最新 UI 树）
        let bounds;
        try { bounds = await findWithBounds(query); }
        catch (cause) { return `错误：${cause.message || cause}（需要无障碍授权）`; }
        const x = bounds?.x ?? bounds?.cx;
        const y = bounds?.y ?? bounds?.cy;
        if (typeof x !== 'number' || typeof y !== 'number') {
          return `未找到匹配「${query}」的元素`;
        }
        // 2) 先试节点 click
        try {
          await findAndClick(query);
          return `已点击「${query}」（索引模式）@(${x},${y}) 边界 ${bounds.w}×${bounds.h} 刷新=${forceRefresh ? '是' : '否'}`;
        } catch { /* 节点 click 失败 */ }
        if (!fallbackToCoord) return `节点 click 失败，坐标 (${x},${y}) 但 fallbackToCoord=false`;
        // 3) 坐标 tap 兜底
        const shizuku = await isShizukuReady().catch(() => ({ ready: false }));
        await inputTap(x, y);
        return `已点击「${query}」（坐标兜底）@(${x},${y})${shizuku.ready ? ' via Shizuku' : ' via 无障碍'} 刷新=${forceRefresh ? '是' : '否'}`;
      } catch (cause) {
        return `错误：${cause.message || cause}`;
      }
    },
  },
  {
    name: 'khy.local.listClickable',
    description: '列出当前屏幕所有可点击节点（text/desc + 坐标 + 尺寸）。Agent 在不确定时调这个 "看看有哪些按钮可以点"。需无障碍授权。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const { listClickable } = await import('./deviceControl.js');
        const items = await listClickable();
        if (!items || !items.length) return '当前屏幕无可点击节点（可能未授无障碍或没有可见按钮）';
        return JSON.stringify({
          count: items.length,
          items: items.slice(0, 50), // 限 50 个，避免 token 爆炸
        }, null, 2);
      } catch (cause) {
        return `错误：${cause.message || cause}（需要无障碍授权）`;
      }
    },
  },
  // ===== Roubao 风格 Tools：HTTP / DeepLink 按 app / 屏幕观察 =====
  {
    // 走 fetch 的通用 HTTP 工具。
    // 仅允许 http(s) + 白名单主机(避免被 AI 拿去打内网/本地端口)。
    name: 'khy.local.http',
    description: '发一个 HTTP 请求。仅支持 https（少数允许 http），并仅限白名单主机（公共 API）。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL，如 https://api.open-meteo.com/v1/forecast?latitude=39&longitude=116&current_weather=true' },
        method: { type: 'string', enum: ['GET', 'POST'], description: '默认 GET' },
        headers: { type: 'object', description: '可选 header 键值对', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: 'POST 请求体（字符串）' },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 8000，上限 15000）', default: 8000 },
      },
      required: ['url'],
    },
    async execute({ url, method = 'GET', headers = {}, body, timeoutMs = 8000 }) {
      const safeUrl = String(url || '').trim();
      if (!/^https?:\/\//i.test(safeUrl)) return `错误：只支持 http(s)，收到：${safeUrl}`;
      const u = new URL(safeUrl);
      const host = u.hostname.toLowerCase();
      // 白名单：只允许公共 API 主机；禁止内网/回环/云 metadata。
      const allowHosts = new Set([
        'api.open-meteo.com', 'wttr.in', 'www.zhihu.com', 'm.zhihu.com',
        'api.github.com', 'api.openai.com', 'dashscope.aliyuncs.com',
        'api.deepseek.com', 'api.moonshot.cn', 'open.bigmodel.cn',
        'apihub.agnes-ai.com', 'shizuku.rikka.app',
      ]);
      const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.', '10.', '192.168.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.'];
      if (blocked.some((p) => host.startsWith(p) || host === p.replace(/\.$/, ''))) {
        return `错误：禁止访问内网/回环地址：${host}`;
      }
      if (!allowHosts.has(host)) return `错误：主机「${host}」不在白名单；如需扩展请在 localTools.js 的 allowHosts 加`;
      const tmo = Math.max(1000, Math.min(15000, Number(timeoutMs) || 8000));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), tmo);
      try {
        const res = await fetch(safeUrl, {
          method,
          headers: { 'User-Agent': 'khy-mobile/1.0', ...(headers || {}) },
          body: method === 'POST' ? (body || '') : undefined,
          signal: ctrl.signal,
        });
        const text = await res.text();
        const snippet = text.length > 4000 ? text.slice(0, 4000) + '...(已截断)' : text;
        return `[HTTP ${res.status} ${res.statusText}] ${snippet}`;
      } catch (cause) {
        return `错误：HTTP 请求失败：${cause.message || cause}`;
      } finally {
        clearTimeout(timer);
      }
    },
  },
  {
    // 按 App 中文/英文名跳 DeepLink。
    // 复用 listApps() 找包名 → 试常见 scheme；找不到就降级到 startActivity。
    name: 'khy.local.deepLinkByApp',
    description: '按 App 名称/包名跳转 DeepLink（导航/外卖/扫码等场景）。优先尝试内置 scheme 映射，失败则回退到 Activity 启动。',
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App 名（中文/英文/拼音）或包名，如"高德""美团""weixin"' },
        url: { type: 'string', description: '可选：要跳转的完整 DeepLink URL（覆盖默认 scheme）' },
      },
      required: ['app'],
    },
    async execute({ app, url }) {
      if (!Capacitor.isNativePlatform()) return '错误：deepLinkByApp 仅在 Android 上可用';
      // 1) 显式 url 优先
      if (url) {
        try {
          await App.openUrl({ url });
          return `已通过 DeepLink 跳转到：${url}`;
        } catch (cause) {
          return `DeepLink 失败（${cause.message || cause}），将尝试启动 App…`;
        }
      }
      // 2) 内置 scheme 映射
      const knownSchemes = {
        'taobao': 'taobao://s.taobao.com',
        '淘宝': 'taobao://s.taobao.com',
        'meituan': 'meituanwaimai://waimai.meituan.com',
        '美团': 'meituanwaimai://waimai.meituan.com',
        '美团外卖': 'meituanwaimai://waimai.meituan.com',
        'weixin': 'weixin://',
        '微信': 'weixin://',
        'didi': 'diditaxi://x.open',
        '滴滴': 'diditaxi://x.open',
        'amap': 'androidamap://poi?sourceApplication=Khy&dev=0',
        '高德': 'androidamap://poi?sourceApplication=Khy&dev=0',
        '高德地图': 'androidamap://poi?sourceApplication=Khy&dev=0',
        'bilibili': 'bilibili://pegasus/channel/hot',
        'b站': 'bilibili://pegasus/channel/hot',
        '哔哩哔哩': 'bilibili://pegasus/channel/hot',
        'zhihu': 'zhihu://',
        '知乎': 'zhihu://',
        'baidu': 'baidumap://',
        '百度': 'baidumap://',
        '百度地图': 'baidumap://',
      };
      const lc = String(app).toLowerCase();
      const scheme = knownSchemes[app] || knownSchemes[lc];
      if (scheme) {
        try {
          await App.openUrl({ url: scheme });
          return `已通过 DeepLink 跳转到「${app}」：${scheme}`;
        } catch { /* 回落 */ }
      }
      // 3) 兜底：Shizuku 启动 Activity
      try {
        const { isShizukuReady, listApps, startActivity } = await import('./deviceControl.js');
        const ready = await isShizukuReady();
        if (!ready.ready) return `错误：Shizuku 不可用（${ready.reason}），无法按名启动 App`;
        const r = await listApps(app);
        const apps = (r && r.apps) || [];
        if (!apps.length) return `未找到名称包含「${app}」的应用`;
        const target = apps[0];
        await startActivity(target.package);
        return `已启动：${target.label}（${target.package}）`;
      } catch (cause) {
        return `错误：${cause.message || cause}`;
      }
    },
  },
  {
    // 屏幕观察器：连续 N 帧描述 + 让 VLM 对比时间序列变化。
    // 与 lookScreen / recordScreen 的区别：本工具额外让 VLM 输出"差异"，直接给 Agent 用。
    name: 'khy.local.screenObserver',
    description: '连续观察屏幕 N 帧（每帧间隔 ms 毫秒），让 VLM 同时输出"每帧描述 + 帧间变化"，适合"看一段时间变化"或"等某页面出现"。',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '截多少帧（默认 5，最多 30）', default: 5 },
        intervalMs: { type: 'integer', description: '帧间隔（默认 1500ms，最小 300）', default: 1500 },
        watchFor: { type: 'string', description: '要等什么，如"加载完成""出现支付页面""出现成功提示"。空 = 只描述变化。' },
        stopOnMatch: { type: 'boolean', description: '若 watchFor 命中是否提前停止（默认 true）', default: true },
        prompt: { type: 'string', description: '附加指令' },
      },
    },
    async execute({ count = 5, intervalMs = 1500, watchFor = '', stopOnMatch = true, prompt }) {
      const { captureFrames, isShareReady, startShare } = await import('./screenCapture.js');
      const { getVlmSelection, getVlmApiKey, visionDescribe } = await import('./visionProvider.js');
      const sel = await getVlmSelection();
      if (!sel?.provider) return '错误：未配置视觉模型。请在「设置 → 视觉模型」里选 provider + 填 API Key。';
      const apiKey = await getVlmApiKey(sel.provider);
      if (!apiKey) return '错误：该 Vision Provider 没配 API Key';

      const c = Math.max(1, Math.min(30, Number(count) || 5));
      const gap = Math.max(300, Math.min(10000, Number(intervalMs) || 1500));

      // 抓屏
      let frames = [];
      if (await isShareReady()) {
        const r = await captureFrames(c, gap);
        frames = r.frames || [];
      } else {
        try {
          await startShare();
          const r = await captureFrames(c, gap);
          frames = r.frames || [];
        } catch (cause) {
          return `错误：抓屏失败：${cause.message || cause}`;
        }
      }
      if (!frames.length) return '错误：未抓到任何帧';

      // 逐帧描述
      const perFrame = [];
      for (let i = 0; i < frames.length; i++) {
        try {
          const desc = await visionDescribe({
            provider: sel.provider, model: sel.model, apiKey,
            image: { dataUrl: 'data:image/jpeg;base64,' + frames[i] },
            prompt: prompt
              ? `${prompt}\n（这是第 ${i + 1}/${frames.length} 帧，相邻 ${gap}ms）`
              : `用中文简短描述这帧屏幕内容（第 ${i + 1}/${frames.length} 帧，相邻 ${gap}ms）。`,
          });
          perFrame.push({ index: i + 1, desc, matched: false });
        } catch (cause) {
          perFrame.push({ index: i + 1, desc: `[VLM 失败: ${cause.message || cause}]`, matched: false });
        }
      }

      // 变化摘要
      const diffPrompt = `下面是 ${perFrame.length} 帧屏幕的描述（每帧间隔约 ${gap}ms）。请输出一段 JSON：\n` +
        `{\n  "summary": "<30 字内整体发生了什么>",\n  "diff": ["<第 1→2 帧的变化>", "<第 2→3 帧的变化>", ...],\n` +
        (watchFor ? `  "watchForHit": <true/false — 是否出现"${watchFor}">,\n  "watchForFrame": <命中帧号 1-${perFrame.length}，否则 0>\n` : `  "watchForHit": false, "watchForFrame": 0\n`) +
        `}\n\n` +
        perFrame.map((p) => `#${p.index} ${p.desc}`).join('\n');

      let final;
      try {
        const text = await visionDescribe({
          provider: sel.provider, model: sel.model, apiKey,
          // 观察器不传图，只让 VLM 看时间序列文本
          image: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' },
          prompt: diffPrompt,
        });
        final = text;
      } catch (cause) {
        final = `[VLM 总结失败: ${cause.message || cause}]`;
      }

      return JSON.stringify({
        count: perFrame.length,
        intervalMs: gap,
        watchFor: watchFor || null,
        frames: perFrame,
        analysis: final,
      }, null, 2);
    },
  },
];

// OpenAI 工具定义格式（直接喂给 LLM）
export function localToolSchemas() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// 工具分发表
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function listLocalTools() {
  return TOOLS.map((t) => ({ name: t.name, description: t.description }));
}

export async function executeLocalTool(name, argsJson) {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, content: `错误：未注册的工具 ${name}` };
  let args = {};
  if (argsJson && typeof argsJson === 'string') {
    try { args = JSON.parse(argsJson); } catch { args = {}; }
  } else if (argsJson && typeof argsJson === 'object') {
    args = argsJson;
  }
  try {
    const content = await tool.execute(args);
    return { ok: true, content: String(content) };
  } catch (cause) {
    return { ok: false, content: `执行失败：${cause.message || cause}` };
  }
}
