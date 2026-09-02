// khy.recorder —— 录制宏（仿 ClawMobile skills）。
//
// 设计：用户在 ChatView 顶栏点「录制」→ recorder 启动 → AI 后续每一步工具调用（tap /
// swipe / type / startActivity / findAndClick / runProgram / runSkill）自动被 push
// 到步骤列表 → 用户再点「停止」+ 给个名字 → saveAsSkill 把步骤列表存为 Skill
// （khy_skill_<name>），下次 AI 可以 khy.local.runSkill 跑它。
//
// 注意：
//   - 录制是"动作回放"，不是"屏幕录像"。每步对应一个独立动作（tool call + 参数）。
//   - 录制过程中 VLM 调用（lookScreen）会被跳过，避免步骤数爆炸。
//   - 工具循环里要传 recorder ref，单例始终在 App 生命周期内。

import { saveSkill, listSkills } from './programRuntime.js';

const recorder = {
  isRecording: false,
  name: '',
  description: '',
  startedAt: 0,
  steps: [], // [{ tool: 'khy.local.tap', args: {x:1,y:2}, ts: 1234 }]
  // 监听到的 step 来源
  onStepCb: null,
};

// 可录制的工具名（其他工具会跳过）
const RECORDABLE_TOOLS = new Set([
  'khy.local.tap',
  'khy.local.swipe',
  'khy.local.typeText',
  'khy.local.openAppByName',
  'khy.local.startActivity',
  'khy.local.findAndClick',
  'khy.local.findAndLongClick',
  'khy.local.openUrl',
  'khy.local.runProgram',
  'khy.local.runSkill',
  // 读 / 写剪贴板也很常见，录下来
  'khy.local.writeClipboard',
  'khy.local.readClipboard',
  // 通用 execShell 也录（受白名单限制）
  'khy.local.execShell',
]);

export function startRecording() {
  recorder.isRecording = true;
  recorder.name = '';
  recorder.description = '';
  recorder.startedAt = Date.now();
  recorder.steps = [];
}

export function stopRecording() {
  recorder.isRecording = false;
}

export function isRecording() {
  return recorder.isRecording;
}

export function getCurrentRecording() {
  return {
    isRecording: recorder.isRecording,
    name: recorder.name,
    description: recorder.description,
    steps: recorder.steps.slice(),
    startedAt: recorder.startedAt,
  };
}

/**
 * 工具循环里每执行一个 tool 前调用。返回 true 表示"已记录"，false 表示"非录制或不可录工具"。
 */
export function recordStep(toolName, args) {
  if (!recorder.isRecording) return false;
  if (!RECORDABLE_TOOLS.has(toolName)) return false;
  recorder.steps.push({
    tool: toolName,
    args: JSON.parse(JSON.stringify(args || {})), // 深拷贝避免引用
    ts: Date.now(),
  });
  return true;
}

/**
 * 把当前录制存为 Skill。存进 khy_skill_<name>。
 * 要求至少有 1 步。
 */
export async function saveAsSkill({ name, description }) {
  if (!name || !name.trim()) {
    throw new Error('Skill 名字不能空');
  }
  if (recorder.steps.length === 0) {
    throw new Error('录制为空，至少要 1 步');
  }
  const skill = {
    name: name.trim(),
    label: name.trim(),
    description: (description || '').trim() || `录制于 ${new Date().toLocaleString()}，${recorder.steps.length} 步`,
    params: {}, // 录制的步骤用真实值，不抽参数（让 AI 学到具体路径）
    steps: recorder.steps.map((s) => ({
      kind: 'recorded',
      tool: s.tool,
      args: s.args,
    })),
  };
  await saveSkill(skill);
  recorder.isRecording = false;
  recorder.steps = [];
  recorder.name = '';
  recorder.description = '';
  return skill;
}

export function cancelRecording() {
  recorder.isRecording = false;
  recorder.steps = [];
  recorder.name = '';
  recorder.description = '';
}
