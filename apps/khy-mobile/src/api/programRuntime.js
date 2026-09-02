// khy.program 小程序运行时
// 一个小程序 = 一份 JSON manifest，描述「能做什么 + 怎么做」。AI 通过
// khy.local.runProgram 跳起来：传 name + args，运行时按 steps 顺序执行。
//
// manifest 形态：
// {
//   "name": "calc-tip",                  // id，AI 调用用
//   "label": "小费计算",                 // UI 显示
//   "description": "输入账单金额和小费率，输出小费",  // 喂给 AI 看
//   "params": { "amount": "账单金额", "rate": "小费率" },
//   "steps": [
//     { "kind": "compute", "expr": "${amount} * ${rate}" },
//     { "kind": "return", "text": "小费：${_result} 元" }
//   ]
// }

function interpolate(template, vars) {
  return String(template).replace(/\$\{([a-zA-Z_][\w]*)\}/g, (m, name) => {
    if (name === '_result') return String(vars._result ?? '');
    return String(vars[name] ?? '');
  });
}

// 深度替换 args 里所有字符串值中的 ${var}
function interpolateArgs(args, vars) {
  if (args == null) return args;
  if (typeof args === 'string') return interpolate(args, vars);
  if (Array.isArray(args)) return args.map((a) => interpolateArgs(a, vars));
  if (typeof args === 'object') {
    const out = {};
    for (const k of Object.keys(args)) out[k] = interpolateArgs(args[k], vars);
    return out;
  }
  return args;
}

// 调 JS 工具（khy.local.* 命名的）——录制宏回放用
async function runRecordedTool(toolName, args) {
  try {
    const tools = await import('./localTools.js');
    if (typeof tools.executeLocalTool !== 'function') {
      return '错误：localTools.js 未导出 executeLocalTool';
    }
    const r = await tools.executeLocalTool(toolName, JSON.stringify(args || {}));
    if (r && r.ok === false) return r.content || '工具执行失败';
    if (r && typeof r.content === 'string') return r.content;
    return typeof r === 'string' ? r : JSON.stringify(r);
  } catch (cause) {
    return `错误：${cause.message || cause}`;
  }
}

function safeEval(expr, vars) {
  const filled = interpolate(expr, vars);
  if (!/^[\d+\-*/().\s%]+$/.test(filled)) {
    throw new Error(`表达式含不允许字符：${filled}`);
  }
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${filled});`)();
}

export async function runProgram(program, args) {
  if (!program || !Array.isArray(program.steps)) {
    return '错误：program manifest 缺 steps';
  }
  const vars = { ...(args || {}) };
  for (let i = 0; i < program.steps.length; i++) {
    const step = program.steps[i];
    try {
      if (step.kind === 'compute') {
        vars._result = safeEval(step.expr || '0', vars);
      } else if (step.kind === 'set') {
        vars[step.key] = interpolate(step.value || '', vars);
      } else if (step.kind === 'return') {
        return interpolate(step.text || '', vars);
      } else if (step.kind === 'openUrl') {
        const url = interpolate(step.url || '', vars);
        if (!/^https?:\/\//i.test(url)) return `错误：openUrl 只支持 http(s)，收到：${url}`;
        window.open(url, '_blank', 'noopener,noreferrer');
        return `已打开：${url}`;
      } else if (step.kind === 'urlEncode') {
        // 把字符串值 URL-encode 后存到指定变量
        vars[step.key || '_encoded'] = encodeURIComponent(String(vars[step.from] ?? ''));
      } else if (step.kind === 'clipboardWrite') {
        const text = interpolate(step.text || '', vars);
        await navigator.clipboard.writeText(text);
        return `已复制 ${text.length} 字符到剪贴板`;
      } else if (step.kind === 'recorded') {
        // 录制宏的步骤：直接调 JS 工具
        const t = step.tool;
        const a = interpolateArgs(step.args || {}, vars);
        const result = await runRecordedTool(t, a);
        // 单步失败继续，让用户看到全部结果；致命错才停
        if (typeof result === 'string' && result.startsWith('错误')) {
          return `第 ${i + 1} 步 ${t} 失败：${result}`;
        }
      } else if (step.kind === 'skip') {
        // 录制时记录了步骤但跑的时候该工具不可用 —— 跳过
        continue;
      } else {
        return `错误：未知 step kind：${step.kind}`;
      }
    } catch (cause) {
      return `step 失败：${cause.message || cause}`;
    }
  }
  // 没有 return step —— 用最后一个 _result
  return vars._result !== undefined ? `完成，结果：${vars._result}` : '小程序已运行（无返回）';
}

// 列出所有已安装小程序（khy_program_* 键），用作 UI
export async function listPrograms() {
  const { Preferences } = await import('@capacitor/preferences');
  const { keys } = await Preferences.keys();
  const programs = [];
  for (const key of keys) {
    if (!key.startsWith('khy_program_')) continue;
    const { value } = await Preferences.get({ key });
    if (!value) continue;
    try {
      const p = JSON.parse(value);
      programs.push({
        name: p.name || key.replace('khy_program_', ''),
        label: p.label || p.name || '',
        description: p.description || '',
        params: p.params || {},
        steps: p.steps || [],
      });
    } catch { /* skip */ }
  }
  return programs;
}

export async function saveProgram(program) {
  const { Preferences } = await import('@capacitor/preferences');
  if (!program?.name) throw new Error('program 必须有 name 字段');
  const payload = JSON.stringify(program);
  await Preferences.set({ key: `khy_program_${program.name}`, value: payload });
}

export async function deleteProgram(name) {
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.remove({ key: `khy_program_${name}` });
}

// 预置几个示例小程序
export const SAMPLE_PROGRAMS = [
  {
    name: 'tip-calc',
    label: '小费计算器',
    description: '输入账单金额和小费率（百分比数字），返回小费金额。',
    params: { amount: '账单金额（元）', rate: '小费率（% ，如 15）' },
    steps: [
      { kind: 'compute', expr: '${amount} * ${rate} / 100' },
      { kind: 'return', text: '账单 ${amount} 元、小费 ${rate}%：小费 ${_result} 元' },
    ],
  },
  {
    name: 'unit-convert',
    label: '摄氏度→华氏度',
    description: '把摄氏度数字转成华氏度。',
    params: { c: '摄氏度' },
    steps: [
      { kind: 'compute', expr: '${c} * 9 / 5 + 32' },
      { kind: 'return', text: '${c}°C = ${_result}°F' },
    ],
  },
  {
    name: 'open-search',
    label: '一键搜知乎',
    description: '在浏览器中打开知乎搜索结果页。',
    params: { q: '搜索关键字' },
    steps: [
      { kind: 'urlEncode', from: 'q', key: 'encoded' },
      { kind: 'openUrl', url: 'https://www.zhihu.com/search?type=content&q=${encoded}' },
    ],
  },
];

// ---------- Skills：复用同套 steps 解释器，但存为 khy_skill_*，
// 名称 + description 喂给 LLM 当"我会什么"清单；调用方式与小程序一致。 ----------

export async function listSkills() {
  const { Preferences } = await import('@capacitor/preferences');
  const { keys } = await Preferences.keys();
  const skills = [];
  for (const key of keys) {
    if (!key.startsWith('khy_skill_')) continue;
    const { value } = await Preferences.get({ key });
    if (!value) continue;
    try {
      const s = JSON.parse(value);
      skills.push({
        name: s.name || key.replace('khy_skill_', ''),
        label: s.label || s.name || '',
        description: s.description || '',
        params: s.params || {},
        steps: s.steps || [],
      });
    } catch { /* skip */ }
  }
  return skills;
}

export async function saveSkill(skill) {
  const { Preferences } = await import('@capacitor/preferences');
  if (!skill?.name) throw new Error('skill 必须有 name 字段');
  await Preferences.set({ key: `khy_skill_${skill.name}`, value: JSON.stringify(skill) });
}

export async function deleteSkill(name) {
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.remove({ key: `khy_skill_${name}` });
}

export async function runSkill(name, args) {
  const { Preferences } = await import('@capacitor/preferences');
  const { value } = await Preferences.get({ key: `khy_skill_${name}` });
  if (!value) return `错误：未找到 Skill「${name}」`;
  const skill = JSON.parse(value);
  return runProgram(skill, args || {});
}

export const SAMPLE_SKILLS = [
  {
    name: 'morning-briefing',
    label: '晨间简报',
    description: '为用户生成一段简短的晨间简报：今天日期 + 一句问候 + 一个鼓励。可传入 tone (gentle/punchy) 调整语气。',
    params: { tone: '语气（gentle / punchy，默认 gentle）' },
    steps: [
      { kind: 'set', key: 'today', value: 'new Date().toLocaleDateString()' },
      { kind: 'return', text: '今天是 ${today}。${tone === "punchy" ? "今天也要赢。" : "愿你今天一切顺利。"}' },
    ],
  },
  {
    name: 'summarize-clipboard',
    label: '总结剪贴板',
    description: '读取剪贴板内容（如果当前没有可读，会返回提示），并尝试用一句话总结。',
    params: {},
    steps: [
      { kind: 'return', text: '请用一句中文总结以下剪贴板内容：\n\n<先让 AI 调用 khy.local.readClipboard 拿到文本再总结>' },
    ],
  },
  // ===== Roubao 风格的"快速路径" Skills — 直接 DeepLink 跳到 AI 能力 App =====
  {
    name: 'order-meituan-takeout',
    label: '点外卖（美团）',
    description: '通过 DeepLink 打开美团外卖搜索结果页。AI 只需传入想吃的关键词（如"汉堡""麻辣烫"），系统跳到美团对应搜索结果。',
    params: { q: '想吃的食物关键词（如"汉堡""麻辣烫""沙拉"）' },
    steps: [
      { kind: 'urlEncode', from: 'q', key: 'encoded' },
      { kind: 'openUrl', url: 'meituanwaimai://waimai.meituan.com/search?query=${encoded}' },
    ],
  },
  {
    name: 'navigate-amap',
    label: '导航（高德）',
    description: '通过 DeepLink 打开高德地图并搜索目的地。',
    params: { q: '目的地（如"北京站""国贸三期"）' },
    steps: [
      { kind: 'urlEncode', from: 'q', key: 'encoded' },
      { kind: 'openUrl', url: 'androidamap://poi?sourceApplication=Khy&keywords=${encoded}&dev=0' },
    ],
  },
  {
    name: 'call-taxi-didi',
    label: '打车（滴滴）',
    description: '通过 DeepLink 打开滴滴并填好目的地。',
    params: { from: '起点（可选）', to: '终点' },
    steps: [
      { kind: 'urlEncode', from: 'to', key: 'to_enc' },
      { kind: 'set', key: 'from_enc', value: 'from ? encodeURIComponent(from) : ""' },
      { kind: 'openUrl', url: 'diditaxi://x.open?type=2&from=${from_enc}&to=${to_enc}' },
    ],
  },
  {
    name: 'send-wechat-quick',
    label: '发微信（DeepLink 快速路径）',
    description: '通过 DeepLink 打开微信扫一扫或搜索页。AI 用此先"打开微信"再做后续操作。',
    params: { tab: '要进的 tab（"scan"=扫一扫, "chats"=聊天, "contacts"=通讯录，默认 chats）' },
    steps: [
      { kind: 'set', key: 'tabId', value: 'tab === "scan" ? "scan" : tab === "contacts" ? "contacts" : "chats"' },
      { kind: 'openUrl', url: 'weixin://' },
    ],
  },
  {
    name: 'price-compare-taobao',
    label: '比价（淘宝）',
    description: '在淘宝搜索商品名，让用户比价。',
    params: { q: '商品关键词' },
    steps: [
      { kind: 'urlEncode', from: 'q', key: 'encoded' },
      { kind: 'openUrl', url: 'taobao://s.taobao.com/?q=${encoded}' },
    ],
  },
  {
    name: 'play-bilibili',
    label: 'B 站热门',
    description: '打开 Bilibili 热门视频页。',
    params: {},
    steps: [
      { kind: 'openUrl', url: 'bilibili://pegasus/channel/hot' },
    ],
  },
];
