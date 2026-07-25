'use strict';

/**
 * learn.js — /learn 命令 handler
 *
 * 交互式 KHY OS 学习课程系统入口。
 * 支持: learn / learn <N> / learn <N>.<M> / learn progress / learn reset / learn next
 *       learn rank | roadmap (成长路线) / learn export [路径] / learn import <路径> [--replace]
 *       learn refresh [--force | clear] (课程动态化：有 AI/网络时自动发现/自愈/AI 扩充)
 *       learn bugs / learn note / learn memory / learn edit / learn check / learn <关键词>
 *
 * 三档模型适配:
 *   smart  — 高能力模型: 面谈式 prompt，像与资深工程师对话
 *   small  — 本地小模型: 精简 prompt，只要求简要概括
 *   none   — 无模型: 纯静态渲染，源码预览 + 导航，不发 AI 请求
 */

const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printInfo, printWarn, printError, printSuccess } = require('../formatters');
const retrieval = require('../../services/learningRetrieval');
const dynamic = require('../../services/learningCurriculumDynamic');
const profile = require('../../services/learningProfile');

/**
 * 检测当前 AI 模型能力档位。
 * @returns {'smart'|'small'|'none'}
 */
function _getModelTier() {
  try {
    const aiMod = require('../ai');
    const ai = typeof aiMod === 'function' ? aiMod() : aiMod;
    if (!ai || typeof ai.chat !== 'function') return 'none';

    // 当前活跃 provider 探测。早期实现调用 ai.getGateway()，但该函数从未出现在
    // ai.js 的 exports（恒为 undefined）→ 适配器列表恒空 → 永远判为 'none'，
    // 模式 3（有模型）根本进不去。改用已导出的 getActiveProvider()（内部经网关，
    // 返回 "适配器名 · 模型" 或 null），缺失时再退回 getAiStatus().provider。全 fail-soft。
    let provider = null;
    try {
      if (typeof ai.getActiveProvider === 'function') provider = ai.getActiveProvider();
    } catch { /* best effort */ }
    if (!provider) {
      try {
        const st = typeof ai.getAiStatus === 'function' ? ai.getAiStatus() : null;
        if (st && st.available) provider = st.provider;
      } catch { /* best effort */ }
    }
    if (!provider) return 'none';

    // 适配器名在 " · 模型" 之前。本地小模型 → small；其余任何可用云端/API
    // provider 一律按高能力 smart（面谈式模式 3，面试备战首选）。
    const name = String(provider).split('·')[0].trim().toLowerCase();
    const isLocal = /(ollama|localllm|\blocal\b|llama\.cpp|lmstudio)/.test(name);
    return isLocal ? 'small' : 'smart';
  } catch {
    return 'none';
  }
}

/**
 * 直连模型单次调用 —— 由 CLI 层提供并注入给 services 层（learningCurriculumDynamic /
 * learningImprove），让那些服务模块**不反向 require cli/ai**（维持 cli→services 分层方向，
 * 不制造 R1 分层倒置 / 巨型环）。fail-soft：模型不可用 / 出错 → 返回 ''，调用方按「无提议」处理。
 */
async function _directCallModel(prompt) {
  try {
    const aiMod = require('../ai');
    const ai = typeof aiMod === 'function' ? aiMod() : aiMod;
    if (!ai || typeof ai.chat !== 'function') return '';
    const res = await ai.chat(prompt, { effort: 'low', stream: false });
    return (res && (res.reply || res.content)) || '';
  } catch {
    return '';
  }
}

// ── 三种学习方式（模型 × 网络能力） ──────────────────────────────────
// 用户要求 /learn 三种方式都能学到 KHY-OS 知识、形成闭环：
//   模式1 本地无网络无模型 / 模式2 有网络无模型 / 模式3 有网络有模型（提高 RAG 召回）。
// _getModelTier 只解析「模型」一维（仍被别处复用）；这里叠加「网络」维度（embedding /
// docs 远端是否可达，按能力探测而非硬编码 host）得到三模式。结果缓存 60s 避免每次翻页
// 都做网络探测；探测全部 bounded、失败即降级（绝不挂死学习流）。
let _modeCache = null;
let _modeCacheAt = 0;
const _MODE_TTL_MS = 60000;

async function _resolveLearnMode() {
  const now = Date.now();
  if (_modeCache && (now - _modeCacheAt) < _MODE_TTL_MS) return _modeCache;
  const tier = _getModelTier();
  const model = tier !== 'none';
  let out;
  if (model) {
    let vector = false;
    try { vector = await retrieval.isEmbeddingReachable(); } catch { vector = false; }
    out = {
      mode: 3, tier, model: true, vector, remote: vector,
      label: `📡 模式3 · 有模型 + ${vector ? '混合RAG(词法+向量)' : '词法RAG'}`,
    };
  } else {
    let remote = false;
    try { remote = await retrieval.isDocsRemoteReachable(); } catch { remote = false; }
    out = remote
      ? { mode: 2, tier, model: false, vector: false, remote: true, label: '📡 模式2 · 有网络无模型 · 离线教学 + 远端补取' }
      : { mode: 1, tier, model: false, vector: false, remote: false, label: '📡 模式1 · 本地无网络无模型 · 纯本地检索' };
  }
  _modeCache = out;
  _modeCacheAt = now;
  return out;
}

/** 诚实的模式横幅：如实显示当前学习方式、是否补取、检索到多少段、动态覆盖层规模。 */
function _printModeBanner(mode, extra = {}) {
  if (!retrieval.RAG_ENABLED) return;
  let line = mode.label;
  if (extra.fetched && extra.fetched.length) line += ` · 已补取 ${extra.fetched.length} 个文件`;
  if (typeof extra.found === 'number') line += ` · 检索 ${extra.found} 段`;
  try {
    if (dynamic.isDynamicEnabled()) {
      const s = dynamic.overlaySummary();
      if (s.topics > 0) line += ` · +${s.topics} 动态知识点`;
      if (s.remaps > 0) line += ` · 自愈 ${s.remaps} 引用`;
    }
  } catch { /* fail-soft */ }
  // 学习者讲解档位 + 改进清单规模（fail-soft，normal/空清单不显，避免噪音）
  try {
    if (profile.getLevel() === 'beginner') line += ' · 档位 零基础';
  } catch { /* fail-soft */ }
  try {
    const n = require('../../services/learningImprove').listFindings().length;
    if (n > 0) line += ` · 改进清单 ${n}`;
  } catch { /* fail-soft */ }
  console.log('  ' + chalk.gray(line));
}

/**
 * 机会式刷新动态覆盖层：进入学习时按当前能力低频刷新（TTL 门禁），fail-soft，
 * 绝不阻断学习流。地板始终可用，刷新失败也无感。
 */
async function _maybeRefreshDynamic(mode) {
  try {
    if (!dynamic.isDynamicEnabled()) return;
    await dynamic.maybeRefreshDynamic({
      useNetwork: mode.remote || mode.vector,
      useModel: mode.model,
      model: mode.tier,
      callModel: mode.model ? _directCallModel : undefined,
    });
  } catch { /* fail-soft */ }
}

/**
 * 层级总览：三模式共用统一检索，离线模式追加「相关材料」，有模型模式注入 RAG。
 * 始终先渲染静态内容（保底），再视情况追加 aiForward。
 */
async function _layerOverview(layer, curriculum) {
  const mode = await _resolveLearnMode();
  await _maybeRefreshDynamic(mode);
  const query = `${layer.title} ${layer.summary || ''}`.trim();
  let ctx = { chunks: [], text: '', usedVector: false };
  try { ctx = await retrieval.buildContext(query, { allowVector: mode.vector }); } catch { /* 降级 */ }

  _printModeBanner(mode, { found: ctx.chunks.length });
  console.log(curriculum.formatLayerOverviewRich(layer));

  if (!mode.model) {
    if (ctx && ctx.text) console.log(retrieval.formatSection(ctx));
    await _offlineLayerInteract(layer, curriculum);
    return true;
  }
  const ragContext = ctx && ctx.text ? ctx.text : '';
  const level = profile.getLevel();
  const prompt = mode.tier === 'smart'
    ? curriculum.buildLayerOverviewPrompt(layer, { ragContext, level })
    : curriculum.buildSimpleLayerPrompt(layer, { ragContext, level });
  return { aiForward: prompt };
}

/**
 * 知识点详情：三模式共用统一检索。模式2 先从远端补取本地缺失的源码/文档，离线模式追加
 * 「相关材料」段，有模型模式把检索到的真实 chunk 注入 prompt（提高召回与 grounding）。
 */
async function _topicDetail(layer, topic, curriculum) {
  const mode = await _resolveLearnMode();
  await _maybeRefreshDynamic(mode);
  // 记录浏览 (轻推跟踪: 浏览未完成提醒)
  curriculum.markTopicViewed(layer.id, topic.id);

  // 模式2：先从配置的远端补取本地缺失的 topic 源码/文档
  let fetched = [];
  if (mode.mode === 2) {
    try { fetched = await retrieval.fetchMissingForTopic(topic); } catch { fetched = []; }
  }

  // 统一检索 KHY-OS 知识库（三模式共用的闭环核心）
  const query = `${topic.title} ${topic.desc || ''}`.trim();
  let ctx = { chunks: [], text: '', usedVector: false };
  try {
    ctx = await retrieval.buildContext(query, {
      topic,
      allowVector: mode.vector,
      extraPaths: fetched.map(f => f.abs),
    });
  } catch { /* 检索失败静默降级，不阻断学习 */ }

  _printModeBanner(mode, { fetched, found: ctx.chunks.length });
  // 有模型时本地源码只是辅助：读不到不刷 "(无法读取)" 噪音，交给 AI 讲解。
  console.log(curriculum.formatTopicDetailRich(layer, topic, { aiTeaching: mode.model }));

  if (!mode.model) {
    // 模式1/2：离线静态渲染 + 追加检索到的相关材料，再进入既有离线交互
    if (ctx && ctx.text) console.log(retrieval.formatSection(ctx));
    await _offlineTopicInteract(layer, topic, curriculum);
    return true;
  }
  // 模式3：把检索到的真实 chunk 注入 prompt
  const ragContext = ctx && ctx.text ? ctx.text : '';
  const level = profile.getLevel();
  const prompt = mode.tier === 'smart'
    ? curriculum.buildLearningPrompt(layer, topic, { ragContext, level })
    : curriculum.buildSimpleTopicPrompt(layer, topic, { ragContext, level });
  return { aiForward: prompt };
}

/** 完成知识点后检查是否达成层级里程碑 */
function _checkMilestone(layerId, curriculum) {
  const layer = curriculum.getLayer(layerId);
  if (!layer) return;
  const p = curriculum.getProgress();
  const total = layer.topics.length;
  const done = layer.topics.filter(t => p.completedTopics.includes(`${layerId}:${t.id}`)).length;

  if (done === total && total > 0) {
    console.log('');
    console.log(`  ${chalk.bold.green('🎉 恭喜！')} ${chalk.bold.white(`第 ${layerId} 层 · ${layer.title}`)} ${chalk.bold.green('全部完成！ +50 XP')}`);
    const nextLayer = curriculum.getLayer(layerId + 1);
    if (nextLayer) {
      console.log(`  ${chalk.dim('下一站:')} ${chalk.bold.cyan(`第 ${nextLayer.id} 层 · ${nextLayer.title}`)} ${chalk.dim('→')} ${chalk.magenta(`learn ${nextLayer.id}`)}`);
    }
    console.log('');
  } else if (total > 0) {
    const remaining = total - done;
    const pct = Math.round((done / total) * 100);
    if (pct >= 50) {
      console.log(`  ${chalk.yellow(`⚡ 第 ${layerId} 层进度 ${pct}%，还差 ${remaining} 个！`)}`);
    }
  }
}

/** 显示轻推提示 (如果有) */
function _showNudge(curriculum) {
  const nudge = curriculum.getNudge();
  if (nudge) {
    console.log(`  ${nudge}`);
    console.log('');
  }
}

// ── Offline Interactive Mode ──────────────────────────────────────────
// 无 AI 模型时，通过 inquirer 选项菜单实现课程浏览、导航、自测

/**
 * inquirer list prompt — Ctrl+C 安全
 * @returns {Promise<*|null>} 选中值, 取消时 null
 */
async function _askChoice(message, options) {
  try {
    const inquirer = require('inquirer');
    const { choice } = await inquirer.prompt([{
      type: 'list',
      name: 'choice',
      message,
      choices: options.map(o => ({ name: o.label, value: o.value })),
      pageSize: 15,
    }]);
    return choice;
  } catch {
    return null;
  }
}

/** 主课程列表 — 选择层级进入 */
async function _offlineLayerListInteract(curriculum) {
  const layers = curriculum.getAllLayers();
  let firstLoop = true;
  while (true) {
    console.log(curriculum.formatLayerList());
    if (firstLoop) { _showNudge(curriculum); firstLoop = false; }

    const progress = curriculum.getProgress();
    const options = layers.map(l => {
      const total = l.topics.length;
      const done = l.topics.filter(t => progress.completedTopics.includes(`${l.id}:${t.id}`)).length;
      const mark = done === total ? chalk.green('✓') : (done > 0 ? chalk.yellow('▸') : chalk.gray('○'));
      return {
        label: `${mark} 第 ${l.id} 层: ${l.title}  ${chalk.dim(`(${done}/${total})`)}`,
        value: { action: 'layer', layer: l },
      };
    });
    options.push({ label: chalk.cyan('📊 学习进度'), value: { action: 'progress' } });
    options.push({ label: chalk.dim('✕ 退出'), value: { action: 'exit' } });

    const choice = await _askChoice('选择层级:', options);
    if (!choice || choice.action === 'exit') return true;

    if (choice.action === 'progress') {
      console.log('\n' + curriculum.formatProgressTable(curriculum.getProgress()) + '\n');
      continue;
    }
    if (choice.action === 'layer') {
      if (choice.layer.id === 10) {
        await _offlineBugListInteract(curriculum);
      } else {
        await _offlineLayerInteract(choice.layer, curriculum);
      }
    }
  }
}

/** 层级概览 — 选择知识点 + 概念自测 */
async function _offlineLayerInteract(layer, curriculum) {
  while (true) {
    const progress = curriculum.getProgress();
    const options = layer.topics.map((t, i) => {
      const done = progress.completedTopics.includes(`${layer.id}:${t.id}`);
      return {
        label: `${done ? chalk.green('✓') : chalk.gray('○')} ${i + 1}. ${t.title}`,
        value: { action: 'topic', index: i },
      };
    });
    if (layer.topics.length >= 3) {
      options.push({ label: chalk.cyan('📝 概念自测'), value: { action: 'quiz' } });
    }
    options.push({ label: chalk.dim('↩ 返回课程列表'), value: { action: 'back' } });

    const choice = await _askChoice(`第 ${layer.id} 层 · ${layer.title}:`, options);
    if (!choice || choice.action === 'back') return;

    if (choice.action === 'topic') {
      await _offlineTopicInteract(layer, layer.topics[choice.index], curriculum);
    }
    if (choice.action === 'quiz') {
      await _runLayerQuiz(layer, curriculum);
    }
  }
}

/** 知识点详情 — 导航 + 标记完成 + 理解检查 */
async function _offlineTopicInteract(layer, startTopic, curriculum) {
  let topic = startTopic;

  while (true) {
    curriculum.markTopicViewed(layer.id, topic.id);
    console.log(curriculum.formatTopicDetailRich(layer, topic));

    const idx = layer.topics.indexOf(topic);
    const options = [];

    if (idx < layer.topics.length - 1) {
      options.push({ label: `→ 下一个: ${layer.topics[idx + 1].title}`, value: 'next' });
    }
    if (idx > 0) {
      options.push({ label: `← 上一个: ${layer.topics[idx - 1].title}`, value: 'prev' });
    }

    const progress = curriculum.getProgress();
    const done = progress.completedTopics.includes(`${layer.id}:${topic.id}`);
    if (!done) {
      options.push({ label: chalk.green('✓ 标记完成'), value: 'done' });
    }
    options.push({ label: chalk.cyan('🧠 理解检查'), value: 'quiz' });
    options.push({ label: chalk.dim('↩ 返回层级'), value: 'back' });

    const choice = await _askChoice('操作:', options);
    if (!choice || choice === 'back') return;

    if (choice === 'next') {
      topic = layer.topics[idx + 1];
    } else if (choice === 'prev') {
      topic = layer.topics[idx - 1];
    } else if (choice === 'done') {
      const p = curriculum.markTopicCompleted(layer.id, topic.id);
      printSuccess(`已完成: ${topic.title} (+10 XP, 总计 ${p.totalXP} XP)`);
      _checkMilestone(layer.id, curriculum);
    } else if (choice === 'quiz') {
      await _runTopicQuiz(layer, topic, curriculum);
    }
  }
}

/** Bug 案例列表 — 选择案例进入 */
async function _offlineBugListInteract(curriculum) {
  const { BUG_CASES } = require('../../data/bugCases');

  while (true) {
    console.log(curriculum.formatBugCaseList());

    const progress = curriculum.getProgress();
    const sevIcon = { critical: '🔴', high: '🟠', medium: '🟡' };
    const options = BUG_CASES.map((c, i) => {
      const done = progress.completedTopics.includes(`10:${c.id}`);
      const mark = done ? chalk.green('✓') : chalk.gray('○');
      return {
        label: `${mark} ${i + 1}. ${sevIcon[c.severity] || '○'} ${c.title}`,
        value: { action: 'bug', bugCase: c },
      };
    });
    options.push({ label: chalk.dim('↩ 返回'), value: { action: 'back' } });

    const choice = await _askChoice('选择案例:', options);
    if (!choice || choice.action === 'back') return;

    if (choice.action === 'bug') {
      await _offlineBugCaseInteract(choice.bugCase, curriculum);
    }
  }
}

/** Bug 案例 — 分步揭示: 症状→根因→修复→经验 */
async function _offlineBugCaseInteract(bugCase, curriculum) {
  const steps = [
    { title: '症状', content: bugCase.symptom },
    { title: '根因分析', content: bugCase.rootCause },
    { title: '修复方案', content: bugCase.fix },
    { title: '经验总结', content: bugCase.lesson },
  ];

  console.log('');
  console.log(`  ${chalk.bold.cyan('🔍 Bug 案例:')} ${chalk.bold.white(bugCase.title)}`);
  console.log(`  ${chalk.dim('─'.repeat(Math.max(8, (process.stdout.columns || 80) - 6)))}`);
  console.log(`  ${chalk.dim('严重等级:')} ${bugCase.severity}  ${chalk.dim('标签:')} ${bugCase.tags.map(t => chalk.cyan(t)).join(chalk.dim(', '))}`);
  console.log(`  ${chalk.dim('文件:')} ${bugCase.files.map(f => chalk.italic.cyan(f)).join(chalk.dim(', '))}`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log('');
    console.log(`  ${chalk.bold.yellow(`第 ${i + 1} 步: ${step.title}`)}`);
    // Wrap long content
    const w = Math.max(20, (process.stdout.columns || 80) - 4);
    const re = new RegExp(`(.{1,${w}})(?:\\s|$)`, 'g');
    const wrapped = step.content.replace(re, '$1\n').trim();
    for (const line of wrapped.split('\n')) {
      console.log(`  ${chalk.white(line)}`);
    }

    if (i < steps.length - 1) {
      const choice = await _askChoice('', [
        { label: `→ 继续: ${steps[i + 1].title}`, value: 'next' },
        { label: chalk.dim('↩ 返回案例列表'), value: 'back' },
      ]);
      if (!choice || choice === 'back') return;
    }
  }

  // 完成后提供标记选项
  console.log('');
  const progress = curriculum.getProgress();
  const done = progress.completedTopics.includes(`10:${bugCase.id}`);
  if (!done) {
    const markChoice = await _askChoice('', [
      { label: chalk.green('✓ 标记完成'), value: 'done' },
      { label: chalk.dim('↩ 返回'), value: 'back' },
    ]);
    if (markChoice === 'done') {
      const p = curriculum.markTopicCompleted(10, bugCase.id);
      printSuccess(`已完成: ${bugCase.title} (+10 XP, 总计 ${p.totalXP} XP)`);
      _checkMilestone(10, curriculum);
    }
  }
}

// ── Quiz — 自动出题 ──────────────────────────────────────────────────

/** 从课程元数据自动生成知识点选择题 */
function _generateTopicQuiz(layer, topic, curriculum) {
  const allLayers = curriculum.getAllLayers().filter(l => l.id !== 10);
  const allTopics = allLayers.flatMap(l => l.topics.map(t => ({ ...t, _layerId: l.id, _layerTitle: l.title })));
  const questions = [];

  // Q1: 层级归属
  const wrongLayers = allLayers.filter(l => l.id !== layer.id).sort(() => Math.random() - 0.5).slice(0, 2);
  if (wrongLayers.length >= 2) {
    questions.push({
      question: `"${topic.title}" 属于哪个层级？`,
      options: [
        { label: `第 ${layer.id} 层 — ${layer.title}`, correct: true },
        ...wrongLayers.map(l => ({ label: `第 ${l.id} 层 — ${l.title}`, correct: false })),
      ].sort(() => Math.random() - 0.5),
    });
  }

  // Q2: 文件关联
  if (topic.files && topic.files.length > 0) {
    const wrongFiles = allTopics
      .filter(t => t.id !== topic.id)
      .flatMap(t => t.files || [])
      .filter(f => !topic.files.includes(f))
      .sort(() => Math.random() - 0.5)
      .slice(0, 2);
    if (wrongFiles.length >= 2) {
      questions.push({
        question: `以下哪个文件与 "${topic.title}" 直接相关？`,
        options: [
          { label: topic.files[0], correct: true },
          ...wrongFiles.map(f => ({ label: f, correct: false })),
        ].sort(() => Math.random() - 0.5),
      });
    }
  }

  // Q3: 描述配对
  const wrongDescs = allTopics.filter(t => t.id !== topic.id && t.desc).sort(() => Math.random() - 0.5).slice(0, 2);
  if (wrongDescs.length >= 2) {
    questions.push({
      question: `以下哪个描述对应 "${topic.title}"？`,
      options: [
        { label: topic.desc, correct: true },
        ...wrongDescs.map(t => ({ label: t.desc, correct: false })),
      ].sort(() => Math.random() - 0.5),
    });
  }

  return questions;
}

/** 知识点理解检查 */
async function _runTopicQuiz(layer, topic, curriculum) {
  const questions = _generateTopicQuiz(layer, topic, curriculum);
  if (questions.length === 0) {
    printInfo('知识点数据不足以生成测试题');
    return;
  }

  let correct = 0;
  console.log('');
  console.log(`  ${chalk.bold.cyan('🧠 理解检查:')} ${chalk.white(topic.title)}`);
  console.log(`  ${chalk.dim('─'.repeat(Math.max(8, (process.stdout.columns || 80) - 6)))}`);

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log('');
    console.log(`  ${chalk.bold(`Q${i + 1}:`)} ${q.question}`);

    const choice = await _askChoice(
      `(${i + 1}/${questions.length})`,
      q.options.map(o => ({ label: o.label, value: o.correct })),
    );
    if (choice === null) return;
    if (choice) {
      correct++;
      printSuccess('  ✓ 正确');
    } else {
      const ans = q.options.find(o => o.correct);
      printWarn(`  ✗ 答案: ${ans.label}`);
    }
  }

  console.log('');
  const pct = Math.round((correct / questions.length) * 100);
  const color = pct === 100 ? chalk.bold.green : (pct >= 50 ? chalk.yellow : chalk.red);
  console.log(`  ${chalk.bold('结果:')} ${color(`${correct}/${questions.length} (${pct}%)`)}`);
  if (pct === 100) printSuccess('  全部正确！');
  console.log('');
}

/** 层级概念自测 — 根据描述选知识点 */
async function _runLayerQuiz(layer, curriculum) {
  const shuffled = [...layer.topics].sort(() => Math.random() - 0.5);
  const count = Math.min(shuffled.length, 4);
  let correct = 0;

  console.log('');
  console.log(`  ${chalk.bold.cyan('📝 概念自测:')} ${chalk.white(`第 ${layer.id} 层 — ${layer.title}`)}`);
  console.log(`  ${chalk.dim('─'.repeat(Math.max(8, (process.stdout.columns || 80) - 6)))}`);
  console.log(`  ${chalk.dim('根据描述，选择对应的知识点')}`);

  for (let i = 0; i < count; i++) {
    const target = shuffled[i];
    const wrongs = layer.topics
      .filter(t => t.id !== target.id)
      .sort(() => Math.random() - 0.5)
      .slice(0, 2);

    const options = [
      { label: target.title, value: true },
      ...wrongs.map(t => ({ label: t.title, value: false })),
    ].sort(() => Math.random() - 0.5);

    console.log('');
    console.log(`  ${chalk.bold(`Q${i + 1}:`)} ${chalk.italic(`"${target.desc}"`)}`);

    const choice = await _askChoice(
      `(${i + 1}/${count})`,
      options.map(o => ({ label: o.label, value: o.value })),
    );
    if (choice === null) return;
    if (choice) {
      correct++;
      printSuccess('  ✓ 正确');
    } else {
      printWarn(`  ✗ 答案: ${target.title}`);
    }
  }

  console.log('');
  const pct = Math.round((correct / count) * 100);
  const color = pct === 100 ? chalk.bold.green : (pct >= 50 ? chalk.yellow : chalk.red);
  console.log(`  ${chalk.bold('结果:')} ${color(`${correct}/${count} (${pct}%)`)}`);
  if (pct === 100) printSuccess('  全部正确！');
  console.log('');
}

// ── 主入口 ────────────────────────────────────────────────────────────

async function handleLearn(subCommand, args) {
  const curriculum = require('../../services/learningCurriculum');

  // ── learn progress ──
  if (subCommand === 'progress') {
    const progress = curriculum.getProgress();
    console.log('\n' + curriculum.formatProgressTable(progress) + '\n');
    return true;
  }

  // ── learn rank / roadmap — 成长路线（修仙境界阶梯）──
  if (subCommand === 'rank' || subCommand === 'roadmap') {
    console.log(curriculum.formatRoadmap(curriculum.getProgress()));
    return true;
  }

  // ── learn export [路径] — 导出进度，换电脑带得走 ──
  if (subCommand === 'export') {
    const res = curriculum.exportProgress(args[0]);
    if (res.ok) {
      printInfo(`学习进度已导出: ${res.path}`);
      printInfo(`包含 ${res.completed} 个已完成知识点，${res.totalXP} XP。在新设备上用 "learn import <文件>" 恢复。`);
    } else {
      printError(`导出失败 (${res.error}): ${res.message}`);
    }
    return true;
  }

  // ── learn import <路径> [--replace] — 导入进度（默认合并）──
  if (subCommand === 'import') {
    const file = args.find(a => !a.startsWith('--'));
    if (!file) {
      printError('用法: learn import <文件路径> [--replace]');
      return true;
    }
    const merge = !args.includes('--replace');
    const res = curriculum.importProgress(file, { merge });
    if (res.ok) {
      printInfo(`进度已${res.mode === 'merge' ? '合并' : '覆盖'}导入: ${res.path}`);
      printInfo(`已完成知识点 ${res.completedBefore} → ${res.completedAfter}，当前 ${res.totalXP} XP。`);
    } else {
      printError(`导入失败 (${res.error}): ${res.message}`);
    }
    return true;
  }

  // ── learn reset ──
  if (subCommand === 'reset') {
    curriculum.resetProgress();
    printWarn('学习进度已重置');
    return true;
  }

  // ── learn next ──
  if (subCommand === 'next') {
    const next = curriculum.getNextTopic();
    if (!next) {
      printInfo('恭喜！全部课程已完成');
      return true;
    }
    if (next.layer.id === 10 && next.topic._bugCase) {
      const bugCase = curriculum.getBugCase(next.topic.id);
      if (bugCase) return { aiForward: curriculum.buildBugCasePrompt(bugCase) };
    }
    return await _topicDetail(next.layer, next.topic, curriculum);
  }

  // ── learn done <layerId> <topicId> ──
  if (subCommand === 'done') {
    const layerId = parseInt(args[0], 10);
    const topicId = args[1];
    if (isNaN(layerId) || !topicId) {
      printError('用法: learn done <层号> <知识点ID>');
      return true;
    }
    const progress = curriculum.markTopicCompleted(layerId, topicId);
    printInfo(`已标记完成: 第 ${layerId} 层 / ${topicId} (+10 XP, 总计 ${progress.totalXP} XP)`);
    _checkMilestone(layerId, curriculum);
    return true;
  }

  // ── learn note <layerId> <topicId> <内容> ──
  if (subCommand === 'note') {
    const layerId = parseInt(args[0], 10);
    const topicId = args[1];
    const note = args.slice(2).join(' ').trim();
    if (isNaN(layerId) || !topicId || !note) {
      printError('用法: learn note <层号> <知识点ID> <笔记内容>');
      return true;
    }
    curriculum.addNote(layerId, topicId, note);
    printInfo(`笔记已添加: 第 ${layerId} 层 / ${topicId}`);
    return true;
  }

  // ── learn memory ──
  if (subCommand === 'memory') {
    const ctx = curriculum.buildLearningMemoryContext();
    if (!ctx) {
      printInfo('还没有学习记录。完成一些知识点后，AI 教学时会自动携带你的学习记忆。');
    } else {
      console.log('\n' + ctx + '\n');
    }
    return true;
  }

  // ── learn check — 文件引用校验 ──
  if (subCommand === 'check') {
    const result = curriculum.checkFileReferences();
    console.log('');
    if (result.missing.length === 0) {
      printInfo(`全部 ${result.total} 个文件引用有效`);
    } else {
      printWarn(`${result.missing.length}/${result.total} 个文件引用失效:\n`);
      for (const m of result.missing) {
        console.log(`  ✗ 第 ${m.layer} 层 / ${m.topic}: ${m.file}`);
      }
      console.log('');
      printInfo('使用 learn edit update-topic <层号> <知识点ID> --files <新路径> 修复');
    }
    return true;
  }

  // ── learn sync — 课程自动同步 ──
  if (subCommand === 'sync') {
    const mode = args[0];
    const report = curriculum.syncCurriculum();

    if (mode === 'auto') {
      // AI 自动生成更新方案
      return { aiForward: curriculum.buildSyncPrompt(report) };
    }

    // 默认: 显示同步报告
    console.log(curriculum.formatSyncReport(report));
    return true;
  }

  // ── learn refresh — 课程动态化：按当前能力刷新动态覆盖层 ──
  // 地板(curriculum.json)永不变；这里把「发现的新模块 / 自愈的失效引用 / AI 扩充」
  // 落到 ~/.khyos 覆盖层，叠加在地板之上。无网无模型也能用（仅做文件系统发现）。
  if (subCommand === 'refresh') {
    if (!dynamic.isDynamicEnabled()) {
      printWarn('课程动态化已关闭 (KHY_LEARN_DYNAMIC=0)，当前仅使用随包地板课程。');
      return true;
    }
    if (args[0] === 'clear' || args[0] === 'reset') {
      dynamic.clearOverlay();
      printInfo('动态覆盖层已清空，已回到纯地板课程。');
      return true;
    }
    const mode = await _resolveLearnMode();
    printInfo(`正在刷新课程（${mode.label}）…`);
    const res = await dynamic.refreshDynamic({
      useNetwork: mode.remote || mode.vector,
      useModel: mode.model,
      model: mode.tier,
      callModel: mode.model ? _directCallModel : undefined,
      force: args.includes('--force'),
    });
    if (!res.ok) {
      printWarn(`刷新未完成 (${res.reason || 'unknown'})，地板课程不受影响。`);
      return true;
    }
    if (res.reason === 'unchanged') {
      printInfo(`课程已是最新：动态知识点 ${res.discovered + res.aiAdded} 个、自愈引用 ${res.healed} 处（无变化）。`);
    } else {
      printSuccess(`课程已刷新：发现 ${res.discovered} 个新模块、自愈 ${res.healed} 处失效引用、AI 新增 ${res.aiAdded} 个知识点。`);
      printInfo('动态内容已即时并入（标「动态/AI」徽标）。"learn refresh clear" 可一键回到纯地板。');
    }
    return true;
  }

  // ── learn edit — 课程 CRUD ──
  if (subCommand === 'edit') {
    return _handleEdit(args, curriculum);
  }

  // ── learn bugs ──
  if (subCommand === 'bugs') {
    const bugArg = args[0];

    if (bugArg === 'export') {
      const jsonl = curriculum.exportBugCasesForTraining();
      console.log('\n' + jsonl + '\n');
      printInfo(`已导出 ${jsonl.split('\n').length} 条训练样本 (JSONL 格式)`);
      return true;
    }

    if (bugArg) {
      const bugCase = curriculum.getBugCase(bugArg);
      if (!bugCase) {
        const idx = parseInt(bugArg, 10) - 1;
        const { BUG_CASES } = require('../../data/bugCases');
        if (idx >= 0 && idx < BUG_CASES.length) {
          return { aiForward: curriculum.buildBugCasePrompt(BUG_CASES[idx]) };
        }
        printError(`未找到案例 "${bugArg}"。使用 learn bugs 查看所有案例`);
        return true;
      }
      return { aiForward: curriculum.buildBugCasePrompt(bugCase) };
    }

    if (_getModelTier() === 'none') {
      await _offlineBugListInteract(curriculum);
      return true;
    }
    console.log(curriculum.formatBugCaseList());
    return true;
  }

  // ── learn level — 讲解档位（零基础 / 常规），持久化到底座领地 ──
  // 三零基础学员可设 beginner：讲解额外做「逐行语法 + 这门语言为什么这样写 + 算法直觉 + Agent 类比」。
  if (subCommand === 'level') {
    if (!args[0]) {
      const lv = profile.getLevel();
      printInfo(`当前讲解档位：${lv === 'beginner' ? '零基础（beginner）' : '常规（normal）'}`);
      printInfo(`切换：learn level beginner | learn level normal（可选项：${profile.LEVELS.join(' | ')}）`);
      return true;
    }
    const res = profile.setLevel(args[0]);
    if (!res.ok) {
      printError(`无效档位 "${args[0]}"。可选项：${profile.LEVELS.join(' | ')}`);
      return true;
    }
    if (res.level === 'beginner') {
      printSuccess('已切到「零基础」档位：讲解会先给生活比喻，再逐行点关键语法 + 这门语言为什么这样写，并主动邀你一起发现不足。');
    } else {
      printSuccess('已切到「常规」档位：恢复标准讲解深度。');
    }
    return true;
  }

  // ── learn improve — 边学边发现不足并完善（清单 + AI 修复提议，绝不自动改代码） ──
  if (subCommand === 'improve') {
    const improve = require('../../services/learningImprove');

    // 复盘：learn improve list
    if (args[0] === 'list' || args[0] === 'ls') {
      const items = improve.listFindings({ limit: 50 });
      console.log(_formatFindings(items));
      return true;
    }

    const route = args.includes('--route');
    const note = args.filter(a => a !== '--route').join(' ').trim();
    if (!note) {
      printWarn('用法：learn improve <你发现的不足>（例：learn improve 这里的错误处理我没看懂为什么要吞异常）');
      printInfo('复盘已记内容：learn improve list');
      return true;
    }

    // 绑定「最近学习的知识点」作为上下文（由 markTopicViewed 维护的 lastVisit，零新增跟踪）
    let layerId = null; let topicId = null; let topicTitle = ''; let files = [];
    try {
      const lv = curriculum.getProgress().lastVisit;
      if (lv && lv.layerId != null) {
        layerId = lv.layerId; topicId = lv.topicId;
        const layer = curriculum.getLayer(lv.layerId);
        const topic = layer && layer.topics.find(t => t.id === lv.topicId);
        if (topic) { topicTitle = topic.title; files = Array.isArray(topic.files) ? topic.files : []; }
      }
    } catch { /* fail-soft：无最近知识点也照样记 */ }

    // 有模型时让 AI 现场给修复提议（直连 callModel，因 aiForward 是 fire-and-forget 拿不回回复）；
    // 无模型则 callModel=null 跳过，清单照样落库（确定性地板）。
    const mode = await _resolveLearnMode();
    const callModel = mode.model ? _directCallModel : null;
    if (mode.model) printInfo('正在请 AI 给一份修复提议（仅展示，不会自动改代码）…');

    const { ok, finding } = await improve.appendFinding(
      { layerId, topicId, topicTitle, files, note },
      { callModel, route },
    );
    const where = finding.layerId != null
      ? `第 ${finding.layerId} 层${finding.topicTitle ? ` · ${finding.topicTitle}` : ''}`
      : '（未绑定知识点）';
    if (ok) printSuccess(`已记入改进清单：[${finding.kind}] ${where}`);
    else printWarn(`已生成改进记录但落盘失败（[${finding.kind}] ${where}），本次提议如下仍可参考。`);
    if (finding.evoRouted) printInfo('已同时投递到 evo 改进管线（--route 触发，KHY_EVO_ENGINE 默认开；设 =off 可关闭）。');
    if (finding.proposalSource === 'model' && finding.proposal) {
      console.log('');
      console.log('  ' + chalk.bold.cyan('AI 修复提议（仅展示，未自动应用）：'));
      console.log(finding.proposal.split('\n').map(l => '  ' + l).join('\n'));
      console.log('');
    } else if (mode.model) {
      printInfo('AI 这次没给出提议（超时/空回复），但你的发现已记入清单，可稍后 learn improve list 复盘。');
    } else {
      printInfo('当前无模型：已记入清单（无 AI 提议）。接入云端网关后可让 AI 给修复建议。');
    }
    return true;
  }

  // ── Combine query ──
  const query = [subCommand, ...args].filter(Boolean).join(' ').trim();

  // ── learn (no args) ──
  if (!query) {
    if (_getModelTier() === 'none') {
      await _offlineLayerListInteract(curriculum);
      return true;
    }
    console.log(curriculum.formatLayerList());
    _showNudge(curriculum);
    return true;
  }

  // ── learn <N>.<M> ──
  const dotMatch = query.match(/^(\d+)\.(\d+)$/);
  if (dotMatch) {
    const layerId = parseInt(dotMatch[1], 10);
    const topicIdx = parseInt(dotMatch[2], 10) - 1;
    const layer = curriculum.getLayer(layerId);
    if (!layer) { printError(`没有第 ${layerId} 层课程`); return true; }
    if (topicIdx < 0 || topicIdx >= layer.topics.length) {
      printError(`第 ${layerId} 层只有 ${layer.topics.length} 个知识点`);
      return true;
    }
    const topic = layer.topics[topicIdx];
    if (layerId === 10 && topic._bugCase) {
      const bugCase = curriculum.getBugCase(topic.id);
      if (bugCase) return { aiForward: curriculum.buildBugCasePrompt(bugCase) };
    }
    return await _topicDetail(layer, topic, curriculum);
  }

  // ── learn <N> ──
  const num = parseInt(query, 10);
  if (!isNaN(num) && String(num) === query.trim()) {
    const layer = curriculum.getLayer(num);
    if (!layer) { printError(`没有第 ${num} 层课程`); return true; }
    if (num === 10) {
      if (_getModelTier() === 'none') {
        await _offlineBugListInteract(curriculum);
        return true;
      }
      console.log(curriculum.formatBugCaseList());
      return true;
    }
    return await _layerOverview(layer, curriculum);
  }

  // ── learn <keyword> ──
  const found = curriculum.findByQuery(query);
  if (found) {
    if (found.topic) {
      if (found.topic._bugCase) {
        const bugCase = curriculum.getBugCase(found.topic.id);
        if (bugCase) return { aiForward: curriculum.buildBugCasePrompt(bugCase) };
      }
      return await _topicDetail(found.layer, found.topic, curriculum);
    }
    if (found.layer.id === 10) {
      if (_getModelTier() === 'none') {
        await _offlineBugListInteract(curriculum);
        return true;
      }
      console.log(curriculum.formatBugCaseList());
      return true;
    }
    return await _layerOverview(found.layer, curriculum);
  }

  printError(`未找到与 "${query}" 相关的课程。使用 learn 查看课程列表`);
  return true;
}

// ── CRUD 子路由 ──────────────────────────────────────────────────────

function _handleEdit(args, curriculum) {
  const action = args[0];

  if (!action) {
    console.log(`
  课程编辑命令:
  ─────────────────────────────────────────────────────
  learn edit add-layer <标题> <概要>
  learn edit rm-layer <层号>
  learn edit update-layer <层号> --title <标题> --summary <概要>

  learn edit add-topic <层号> <知识点ID> <标题> <描述> [--files f1,f2]
  learn edit rm-topic <层号> <知识点ID>
  learn edit update-topic <层号> <知识点ID> [--title X] [--desc X] [--files f1,f2]
  learn edit mv-topic <源层号> <知识点ID> <目标层号> [位置]

  learn edit list                 — 显示完整课程结构 (JSON 路径)
  ─────────────────────────────────────────────────────
`);
    return true;
  }

  if (action === 'list') {
    const layers = curriculum.getAllLayers();
    for (const l of layers) {
      if (l.id === 10) { console.log(`  [${l.id}] ${l.title} (动态生成, 编辑 bugCases.js)`); continue; }
      console.log(`  [${l.id}] ${l.title} — ${l.topics.length} 知识点`);
      for (const t of l.topics) {
        console.log(`    ├─ ${t.id}: ${t.title}  files=[${t.files.join(', ')}]`);
      }
    }
    printInfo(`数据文件: backend/src/data/curriculum.json`);
    return true;
  }

  if (action === 'add-layer') {
    const title = args[1];
    const summary = args.slice(2).join(' ');
    if (!title) { printError('用法: learn edit add-layer <标题> <概要>'); return true; }
    const layer = curriculum.addLayer(title, summary || '');
    printInfo(`新增第 ${layer.id} 层: ${layer.title}`);
    return true;
  }

  if (action === 'rm-layer') {
    const id = parseInt(args[1], 10);
    if (isNaN(id)) { printError('用法: learn edit rm-layer <层号>'); return true; }
    const removed = curriculum.removeLayer(id);
    if (!removed) { printError(`第 ${id} 层不存在`); return true; }
    printWarn(`已删除第 ${id} 层: ${removed.title} (含 ${removed.topics.length} 个知识点)`);
    return true;
  }

  if (action === 'update-layer') {
    const id = parseInt(args[1], 10);
    if (isNaN(id)) { printError('用法: learn edit update-layer <层号> --title X --summary X'); return true; }
    const updates = _parseFlags(args.slice(2));
    const layer = curriculum.updateLayer(id, updates);
    if (!layer) { printError(`第 ${id} 层不存在`); return true; }
    printInfo(`已更新第 ${id} 层: ${layer.title}`);
    return true;
  }

  if (action === 'add-topic') {
    const layerId = parseInt(args[1], 10);
    const topicId = args[2];
    const title = args[3];
    const rest = args.slice(4);
    const flags = _parseFlags(rest);
    const desc = flags.desc || rest.filter(a => !a.startsWith('--')).join(' ');
    const files = flags.files ? flags.files.split(',').map(f => f.trim()) : [];
    if (isNaN(layerId) || !topicId || !title) {
      printError('用法: learn edit add-topic <层号> <知识点ID> <标题> <描述> [--files f1,f2]');
      return true;
    }
    const result = curriculum.addTopic(layerId, topicId, title, desc, files);
    if (!result) { printError(`第 ${layerId} 层不存在`); return true; }
    if (result.error === 'duplicate') { printError(`知识点 ${topicId} 已存在于第 ${layerId} 层`); return true; }
    printInfo(`新增: 第 ${layerId} 层 / ${topicId} — ${title}`);
    return true;
  }

  if (action === 'rm-topic') {
    const layerId = parseInt(args[1], 10);
    const topicId = args[2];
    if (isNaN(layerId) || !topicId) { printError('用法: learn edit rm-topic <层号> <知识点ID>'); return true; }
    const removed = curriculum.removeTopic(layerId, topicId);
    if (!removed) { printError(`未找到 第 ${layerId} 层 / ${topicId}`); return true; }
    printWarn(`已删除: 第 ${layerId} 层 / ${topicId} — ${removed.title}`);
    return true;
  }

  if (action === 'update-topic') {
    const layerId = parseInt(args[1], 10);
    const topicId = args[2];
    if (isNaN(layerId) || !topicId) { printError('用法: learn edit update-topic <层号> <知识点ID> [--title X] [--desc X] [--files f1,f2]'); return true; }
    const updates = _parseFlags(args.slice(3));
    if (updates.files) updates.files = updates.files.split(',').map(f => f.trim());
    const topic = curriculum.updateTopic(layerId, topicId, updates);
    if (!topic) { printError(`未找到 第 ${layerId} 层 / ${topicId}`); return true; }
    printInfo(`已更新: 第 ${layerId} 层 / ${topicId} — ${topic.title}`);
    return true;
  }

  if (action === 'mv-topic') {
    const fromLayer = parseInt(args[1], 10);
    const topicId = args[2];
    const toLayer = parseInt(args[3], 10);
    const pos = args[4] !== undefined ? parseInt(args[4], 10) : undefined;
    if (isNaN(fromLayer) || !topicId || isNaN(toLayer)) {
      printError('用法: learn edit mv-topic <源层号> <知识点ID> <目标层号> [位置]');
      return true;
    }
    const topic = curriculum.moveTopic(fromLayer, topicId, toLayer, pos);
    if (!topic) { printError('移动失败: 层或知识点不存在'); return true; }
    printInfo(`已移动 ${topicId}: 第 ${fromLayer} 层 → 第 ${toLayer} 层`);
    return true;
  }

  printError(`未知编辑操作: ${action}。使用 learn edit 查看所有操作`);
  return true;
}

/** 渲染改进清单（最新在前），fail-soft 纯展示。 */
function _formatFindings(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '\n  ' + chalk.gray('改进清单为空。学习中发现不足时用 learn improve <描述> 记下，和 AI 一起完善 KHY。') + '\n';
  }
  const lines = ['', '  ' + chalk.bold.white(`📋 改进清单（共 ${items.length} 条，最新在前）`), ''];
  for (const f of items) {
    const where = f.layerId != null
      ? `第${f.layerId}层${f.topicTitle ? `·${f.topicTitle}` : ''}`
      : '未绑定';
    const at = (f.at || '').slice(0, 16).replace('T', ' ');
    lines.push(`  ${chalk.cyan(`[${f.kind}]`)} ${chalk.gray(at)} ${chalk.dim(where)}`);
    lines.push(`    ${f.note}`);
    if (f.proposalSource === 'model' && f.proposal) {
      const head = f.proposal.split('\n').filter(Boolean)[0] || '';
      lines.push('    ' + chalk.green('↳ AI 提议: ') + chalk.gray(head.slice(0, 80) + (head.length > 80 ? '…' : '')));
    }
    lines.push('');
  }
  return lines.join('\n');
}

function _parseFlags(tokens) {
  const result = {};
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].startsWith('--') && i + 1 < tokens.length) {
      const key = tokens[i].slice(2);
      const vals = [];
      for (let j = i + 1; j < tokens.length && !tokens[j].startsWith('--'); j++) {
        vals.push(tokens[j]);
        i = j;
      }
      result[key] = vals.join(' ');
    }
  }
  return result;
}

module.exports = { handleLearn, _getModelTier };
