'use strict';

// 收敛到 utils/normalizeToolName 单一真源(逐字节委托,调用点不变)
const normalizeToolName = require('../utils/normalizeToolName');

function classifyToolFailureDetail(detail = '') {
  const cleanDetail = String(detail || '').replace(/\s+/g, ' ').trim();
  const lower = cleanDetail.toLowerCase();
  if (!lower) return '';

  if (
    /(permission denied|access denied|forbidden|unauthorized|denied by policy|eacces|eperm|权限|无权|拒绝访问|禁止)/.test(lower)
  ) {
    return 'permission';
  }
  if (
    /(old_string not found|exact text mismatch|content mismatch|内容不匹配|上下文不匹配|fuzzy match|did not match)/.test(lower)
  ) {
    return 'mismatch';
  }
  if (
    /(not found|no such file|enoent|does not exist|missing|未找到|不存在|缺少|找不到)/.test(lower)
  ) {
    return 'not_found';
  }
  if (
    /(timed out|timeout|deadline exceeded|超时|超出了时间限制)/.test(lower)
  ) {
    return 'timeout';
  }
  if (
    /(cannot parse|parse error|parse failed|invalid json|json parse|unexpected token|格式错误|解析失败|返回格式|无法解析)/.test(lower)
  ) {
    return 'parse';
  }
  if (
    /(failed|failure|error|exception|traceback|fatal|异常|失败|报错)/.test(lower)
  ) {
    return 'generic';
  }
  return '';
}

function toolResultLooksFailed(detail = '') {
  return classifyToolFailureDetail(detail) !== '';
}

function toolResultReflection(toolName, success, detail = '') {
  const name = normalizeToolName(toolName);
  const failureKind = classifyToolFailureDetail(detail);

  if (!success) {
    if (failureKind === 'permission') return '像是权限卡住了，我先换条不碰权限边界的路继续。';
    if (failureKind === 'not_found') return '像是目标没对上，我先把路径和名字重新对齐。';
    if (failureKind === 'timeout') return '这条链路有点卡，我先换个更轻的入口拿关键信息。';
    if (failureKind === 'mismatch') return '上下文没对齐，我先把当前内容重新对齐再改。';
    if (failureKind === 'parse') return '返回格式有点乱，我先把输入收窄一点再跑。';
    if (failureKind === 'generic') return '这个报错说明当前入口不太对，我换条更稳的线继续。';
    return '这条路有点偏，我换条更稳的线继续。';
  }

  if (name === 'grep' || name === 'glob' || name === 'find' || name === 'search' || name === 'ls') {
    return '位置找到了，范围已经收住，我接着看目标实现。';
  }
  if (name === 'read' || name === 'readfile' || name === 'notebookread') {
    return '实现看清了，改动点也清楚了，我接着改。';
  }
  if (name === 'write' || name === 'writefile' || name === 'createfile' || name === 'edit' || name === 'editfile' || name === 'multiedit' || name === 'notebookedit') {
    return '改动已经落下去了，我再跑一遍确认有没有偏。';
  }
  if (name === 'bash' || name === 'shell' || name === 'shellcommand' || name === 'command') {
    return '结果拿到了，接下来就按这条线继续。';
  }
  if (name === 'websearch' || name === 'webfetch') {
    return '外部信息够了，判断基础够了，我接着收口。';
  }
  if (name === 'agent' || name === 'task') {
    return '结果回来了，关键块齐了，我来收一下。';
  }

  return '';
}

module.exports = {
  classifyToolFailureDetail,
  toolResultLooksFailed,
  toolResultReflection,
};
