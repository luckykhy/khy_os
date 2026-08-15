/**
 * gen-evolution-prompts.js — Khy-OS 进化提示词手册（1000 条）确定性生成器
 *
 * 目的
 *   为「弱智 AI / 4B 小模型 / khy 自己」预制 1000 条可直接照做的进化提示词，
 *   每条锚定真实子系统、真实文件、真实 verify 命令，并把项目工作纪律（B1/B2/B3、
 *   红线、五道验证门）作为通用篇固化下来。系统长大后改本文件重跑即可让手册重生。
 *
 * 数据源（单一真源，绝不臆造子系统）
 *   docs/_维护者/维护映射表.json — 10 个 area，各带 whenToUse / paths / docs / verify。
 *
 * 安全契约
 *   - 本脚本零副作用地 build()（纯计算、确定性、无网络、无随机、无时钟）。
 *   - 仅当作为主模块运行时才写出 .md 文档；被 require 时只导出 build()。
 *   - 生成的每条 verify 只能来自「安全命令白名单」，绝不出现 git commit/push、rm、
 *     curl/wget、npm publish、twine 等破坏性或外发命令（由 isSafeVerify 兜底 + 自测硬保）。
 *
 * 用法
 *   node scripts/docs/gen-evolution-prompts.js          # 写出 OPS-MAN-066 手册
 *   node -e "console.log(require('./scripts/docs/gen-evolution-prompts').build().prompts.length)"  # 1000
 *
 * HOW-TO-EXTEND（给下一个维护者/小模型）
 *   1. 想加「通用纪律」→ 往 GENERAL 数组尾部追加一条 {text, note, v}。
 *   2. 想加「进化配方」→ 往 RECIPES 数组追加一条 {t, n, v}（t/n 里用 ${label} 占位）。
 *   3. v 只能填 VERIFY_KEYS 里的键或 'area'（用该子系统自己的 verify）。
 *   4. 新子系统请先登记进 docs/_维护者/维护映射表.json，本手册会自动覆盖它。
 *   5. 改完跑：node --test scripts/tests/gen-evolution-prompts.test.js（必须绿）。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MAP_PATH = path.join(ROOT, 'docs', '_维护者', '维护映射表.json');
const DOC_PATH = path.join(
  ROOT,
  'docs',
  '07_OPS_运维',
  '[OPS-MAN-066] khyos进化提示词手册-1000条.md'
);

const TARGET_COUNT = 1000;

// ── 安全命令白名单（键 → 具体命令）。只读/自检/构建类，无任何破坏性或外发操作。──
const VERIFY_KEYS = {
  agent: 'npm run check:agent-rules',
  change: 'npm run check:change-safety',
  leaf: 'npm run check:leaf-contract',
  model: 'npm run check:model-hardcoding',
  flag: 'npm run check:flag-registry',
  safety: 'npm run check:small-model:safety',
  qg: 'npm run check:quality-gates',
  version: 'npm run check:version-sync',
  arch: 'npm run arch:god',
  maint: 'npm run maintainer:check',
  all: 'npm run test:maintainer:all',
  doctor: 'khy doctor',
};

// 破坏性/外发命令特征：任一命中即拒绝（自测也会独立复核）。
const DANGER_TOKENS = [
  'git commit', 'git push', 'git add', 'git reset', 'git checkout',
  'rm ', 'rm-', 'sudo', 'curl', 'wget', 'scp ', 'ssh ',
  'npm publish', 'yarn publish', 'pip install', 'pip uninstall', 'twine',
  'chmod', 'chown', 'mkfs', 'dd ', 'mv ', ':(){', 'eval ', '>/dev/', '> /',
];

/** 判定一条 verify 命令是否安全（非空、无破坏性特征）。绝不抛。 */
function isSafeVerify(cmd) {
  try {
    if (typeof cmd !== 'string') return false;
    const s = cmd.trim();
    if (!s) return false;
    const low = s.toLowerCase();
    for (const tok of DANGER_TOKENS) {
      if (low.includes(tok)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 读维护映射表；失败则返回空结构（绝不抛，退化为仅通用篇）。 */
function loadAreas() {
  try {
    const raw = fs.readFileSync(MAP_PATH, 'utf8');
    const json = JSON.parse(raw);
    const areas = Array.isArray(json.areas) ? json.areas : [];
    return areas.map((a) => ({
      id: String(a.id || ''),
      label: String(a.label || a.id || '子系统'),
      whenToUse: Array.isArray(a.whenToUse) ? a.whenToUse.map(String) : [],
      paths: Array.isArray(a.paths) ? a.paths.map(String) : [],
      docs: Array.isArray(a.docs) ? a.docs.map(String) : [],
      verify: (Array.isArray(a.verify) ? a.verify.map(String) : []).filter(isSafeVerify),
    }));
  } catch {
    return [];
  }
}

/** 解析某 area 的默认安全 verify（其自身第一条安全命令，否则回退 maintainer:check）。 */
function areaVerify(a) {
  return (a.verify && a.verify[0]) || VERIFY_KEYS.maint;
}

/** 把 verify 键解析为具体命令。'area' → 用该子系统自己的 verify。 */
function resolveVerify(key, a) {
  if (key === 'area') return areaVerify(a);
  const cmd = VERIFY_KEYS[key];
  return isSafeVerify(cmd) ? cmd : VERIFY_KEYS.maint;
}

// ── 通用篇：项目工作纪律与红线（子系统无关的方法论真身）。──
const GENERAL = [
  { text: '每次动手前先做 B1：用一句话说清「改什么 / 为什么 / 影响面」，说不清就先别改。', note: '先想再写，避免瞎改。', v: 'agent' },
  { text: '用 B2 目标驱动循环：先定义可验证的成功标准，再自循环到绿，验证没过绝不说「修好了」。', note: '核心方法论。', v: 'maint' },
  { text: '遵守 B3 外科手术式改动：只动该动的，不顺手重构、不扩大范围。', note: '把改动面压到最小。', v: 'change' },
  { text: '改任何文件前，先读 .ai/MAP.md 与 docs/_维护者/维护映射表.json 定位正确子系统。', note: '别在错的地方改。', v: 'maint' },
  { text: '多步任务先列 plan，每一步都写明它自己的 verify 命令。', note: '每步可验证。', v: 'agent' },
  { text: '红线：绝不 AI 自动 commit/push，任何提交都要用户明确点头。', note: '提交权在人。', v: 'agent' },
  { text: '红线：真 key/token 绝不进源码 / 包 / 提交，只经 env 注入，日志只打印长度不打印明文。', note: '密钥防泄露。', v: 'model' },
  { text: '红线：任何文件不得新增超过 2500 行；超了就按 god-file 治理抽叶子。', note: '上帝文件门。', v: 'arch' },
  { text: '红线：pip khy-os 与 npm @khy-os/khy-os 版本号必须一致。', note: '双渠道同步。', v: 'version' },
  { text: '抽取 god-file 时保字节等价：同名 re-export + DI 注入，函数体一字不改。', note: '拆解不改行为。', v: 'arch' },
  { text: '新增开关必须先在 flagRegistry 登记，未登记的 flag 会被当作恒放行。', note: '门要先登记。', v: 'flag' },
  { text: '纯叶子三铁律：零 IO、确定性、绝不抛异常（任何异常都返回安全默认值）。', note: '叶子契约。', v: 'leaf' },
  { text: 'node:test 文件必须用 `node --test` 跑，别用 jest 前缀（会假阳）。', note: '别跑错 runner。', v: 'all' },
  { text: '判断测试红灯是不是自己造成的：用 git stash / pristine backup 对照，别把既有红算作本次破坏。', note: '甄别 pre-existing。', v: 'change' },
  { text: '三守卫用 --changed 扫；untracked 新叶子不在 diff 里，必须显式传路径扫。', note: '新叶子要显式扫。', v: 'agent' },
  { text: '收尾五门：node --check、相关测试、arch:god、三守卫、maintainer:check，全绿才回报。', note: '做完的定义。', v: 'maint' },
  { text: '每完成一个子任务就更新 memory：写清「为什么这么改」而不是「改了什么」。', note: '沉淀非显然信息。', v: 'maint' },
  { text: '需求不确定先问清，别猜着改；能从代码/默认值确定的就直接做。', note: '该问就问。', v: 'agent' },
  { text: '破坏性操作（删除/覆盖）前先看目标内容，若与描述矛盾就停下来报告。', note: '删前先看。', v: 'change' },
  { text: '给弱模型留路：变量名自解释、关键分支有注释、注册表上方有 HOW-TO-EXTEND。', note: '可维护性优先。', v: 'maint' },
  { text: '每个新子系统必须登记进维护映射表（whenToUse/paths/docs/verify 四要素齐全）。', note: '登记才可发现。', v: 'maint' },
  { text: '每个新叶子配一条 node:test，并并入 test:maintainer:all 一键自证。', note: '测试并网。', v: 'all' },
  { text: '优先复用已有机制（维护映射表、flagRegistry 等），别另造平行体系。', note: '不重复造轮子。', v: 'maint' },
  { text: '改动涉及网关核心时，跑 test:maintainer:gateway 并 khy doctor 双确认。', note: '网关双保。', v: 'doctor' },
  { text: '改动涉及启动/端口/守护进程时，跑 test:maintainer:runtime 并 khy doctor。', note: '运行时双保。', v: 'doctor' },
  { text: '改动涉及 CLI 路由/别名时，跑 test:maintainer:cli-routing 确认命令仍分发正确。', note: '路由自证。', v: 'maint' },
  { text: '改动涉及发布/版本时，先跑 check:version-sync 再动手。', note: '版本先对齐。', v: 'version' },
  { text: '改动涉及打包布局时，跑 check:quality-gates 覆盖 manifest 与语法。', note: '打包自检。', v: 'qg' },
  { text: '任何「已验证」的声称都要附具体证据（通过数/退出码/测试名），空口不算。', note: '证据门。', v: 'maint' },
  { text: '卡住或预算耗尽时，如实报告卡在哪、红灯输出、已试过什么、下一步建议，绝不假报成功。', note: '诚实回报。', v: 'agent' },
  { text: '给错误路径补指名道姓的可执行指引，别让用户对着「未知错误」发懵。', note: '错误可执行。', v: 'maint' },
  { text: '敏感操作走确定性处理器/审批网关，别让模型自由裁量安全边界。', note: '安全不靠裁量。', v: 'safety' },
  { text: '平台差异（linux/windows/macos/android/ios）收在注册表白名单一处，不 smear。', note: '差异集中。', v: 'maint' },
  { text: '截断/采样/限数时必须 log 丢了什么，杜绝「静默截断＝看似全覆盖」。', note: '别静默丢。', v: 'change' },
  { text: '时间/随机相关逻辑改为可注入，让测试确定性、可离线复现。', note: '可测性。', v: 'agent' },
  { text: '每轮重复构建的结构（Set/正则/常量）提升为模块常量（参考书 Ch2）。', note: '别每轮重建。', v: 'arch' },
  { text: 'flag 语义：opt-in 严格只认 1/true；default-on 只有关键词才关。', note: '门语义。', v: 'flag' },
  { text: '父门关闭必须强制子功能整体关闭，补一条门控测试守护它。', note: '父子门链。', v: 'flag' },
  { text: '改完立刻自测，红灯就在本轮修，不把红灯留给下一步。', note: '本轮清红。', v: 'maint' },
  { text: '一次只推进一个可验证的小目标，绿了再开下一个。', note: '小步快跑。', v: 'agent' },
  { text: '不确定命令是否安全时，先用只读方式查，别直接跑破坏性命令。', note: '先只读。', v: 'agent' },
  { text: '维护映射表里列的 paths 必须真实存在，删文件时同步更新映射表。', note: '路径不悬空。', v: 'maint' },
  { text: '文档改动后同步更新分类索引与主索引的条目和计数。', note: '索引同步。', v: 'maint' },
  { text: '给每个子系统一条「一句话验证脚本」，让 4B 小模型也能自证绿灯。', note: '一句话可验。', v: 'all' },
  { text: '抽取叶子后 grep 每个被调函数，确认无死引用、无漏迁的反向边。', note: '抽取查引用。', v: 'leaf' },
  { text: '巨型 switch 按 case 簇抽子分派器，用 pre-dispatch + 哨兵 fall-through 保安全。', note: 'switch 拆解。', v: 'arch' },
  { text: '可变状态跨簇共享时不可净抽，必须用 DI 注入证伪「共享数组」。', note: '共享态用 DI。', v: 'arch' },
  { text: '每条 memory 只存一个事实，配 frontmatter，并在 MEMORY.md 留一行指针。', note: 'memory 规范。', v: 'maint' },
  { text: '别存代码结构/git 历史能查到的东西，只存非显然的「为什么」。', note: '存该存的。', v: 'maint' },
  { text: '用 [[name]] 链接相关 memory，织成传承网络。', note: '记忆织网。', v: 'maint' },
  { text: '发布前用 wheel 对已知泄露 key 做 0 命中校验。', note: '发包零泄漏。', v: 'model' },
  { text: '占位 key 必须一眼假，不得是真 key 的篡改副本。', note: '占位要假。', v: 'model' },
  { text: '双通道发布用 publish-dual.sh，preflight 自动派生 token，杜绝裂脑。', note: '发布不裂脑。', v: 'version' },
  { text: '回滚看 maintenance/stable-release.json 找上一个 known-good 版本。', note: '回滚有据。', v: 'version' },
  { text: '每次大改后跑 test:maintainer:all 做一次全子系统体检。', note: '全量体检。', v: 'all' },
  { text: 'arch:god 报的超限文件先甄别 pre-existing，别把既有债算作新增。', note: '别背旧债。', v: 'arch' },
  { text: '给关键常量注释「为什么是这个值」（上限来源、保守高估等）。', note: '常量讲来源。', v: 'change' },
  { text: '用户可见文案统一措辞，别同义词乱用误导弱模型。', note: '文案一致。', v: 'maint' },
  { text: '每个 PR 级改动配「完成标准」段，逐条对着证据核对。', note: '完成契约。', v: 'maint' },
  { text: '说再见后也要能自证：任何人跑 test:maintainer:all 全绿即系统健康。', note: '可自证健康。', v: 'all' },
];

// ── 进化配方：子系统无关的工程动作，逐一实例化到每个 area（${label} 占位）。──
const RECIPES = [
  { t: '为「${label}」增加一个 flag 门控的纯叶子：零 IO、绝不抛异常，先在 flagRegistry 登记 KHY_* 门再接线。', n: '新能力走门控叶子。', v: 'flag' },
  { t: '为「${label}」补一条 node:test，至少覆盖：正常路径、一个边界、一个畸形/空输入。', n: '补测试。', v: 'area' },
  { t: '通读「${label}」核心文件，在顶部一句话写清职责，并给最难懂的分支补一句注释（不改行为）。', n: '补可读性。', v: 'area' },
  { t: '扫描「${label}」是否有文件超 2500 行；若有，按同名 re-export + DI 抽一个聚焦叶子，保字节等价。', n: '拆上帝文件。', v: 'arch' },
  { t: '给「${label}」的注册表叶子（_PROBES/_REPAIRS 之类）上方补 4 步 HOW-TO-EXTEND 抄写式注释。', n: '注册表可扩展。', v: 'maint' },
  { t: '把「${label}」中每轮/每请求重复构建的 Set/正则/常量提升为模块常量（参考书 Ch2）。', n: '别每轮重建。', v: 'arch' },
  { t: '为「${label}」增加一个只读诊断探针：只观测不修改，绝不写盘、绝不发网络。', n: '加只读探针。', v: 'area' },
  { t: '为「${label}」增加一个「仅创建缺失项」的安全自愈：幂等、fail-soft、遇损坏拒删交人工。', n: '加安全修复。', v: 'area' },
  { t: '给「${label}」的失败路径补一条指名道姓的可执行指引，把错误码翻译成用户能照做的步骤。', n: '错误可执行。', v: 'area' },
  { t: '核对「${label}」的 verify 命令仍能一键复现绿灯；若命令漂移就修 package.json 别名。', n: 'verify 不漂移。', v: 'area' },
  { t: '为「${label}」新增功能前先在 flagRegistry 登记开关，并确认父门链正确（父关则子必关）。', n: '门先登记。', v: 'flag' },
  { t: '为「${label}」的输入做防御式校验：null/undefined/空数组/超长都有明确且安全的默认行为。', n: '防御式输入。', v: 'area' },
  { t: '给「${label}」的外部调用加超时与失败兜底，任何一路挂了都 fail-soft 而不是整体崩。', n: '失败兜底。', v: 'area' },
  { t: '为「${label}」补一条针对历史 bug 的回归测试，命名写清它守护的是哪个坑。', n: '回归测试。', v: 'area' },
  { t: '检查「${label}」的日志：敏感值只打印长度不打印明文，绝不把 key/token 落盘或进日志。', n: '日志脱敏。', v: 'model' },
  { t: '为「${label}」写一条 golden 测试：把一次已知正确的输出固化，防止未来悄悄漂移。', n: 'golden 固化。', v: 'area' },
  { t: '为「${label}」排查可变状态跨簇共享：若被多处重赋值，抽取时必须用 DI 注入而非复制。', n: '共享态用 DI。', v: 'arch' },
  { t: '为「${label}」补一个进程级缓存的测试重置钩子，避免测试间状态串味。', n: '缓存可重置。', v: 'area' },
  { t: '把「${label}」里散落的模型名/端点字面量收敛到单一权威来源（SSOT 访问器）。', n: '收敛字面量。', v: 'model' },
  { t: '为「${label}」的公共函数补 JSDoc：写清意图、参数契约、返回值与副作用。', n: '补 JSDoc。', v: 'agent' },
  { t: '为「${label}」增加空参数补全保护：工具/命令缺关键参数时给出可推断的安全默认。', n: '空参补全。', v: 'area' },
  { t: '为「${label}」抽取叶子后 grep 每个被调函数，凡叶子调而宿主定义者必迁或 DI。', n: '查死引用。', v: 'leaf' },
  { t: '为「${label}」写一条场景测试：模拟一个真实用户操作序列，断言端到端结果。', n: '场景测试。', v: 'area' },
  { t: '把「${label}」里超过三层的嵌套条件重构为早返回（guard clause），降低阅读成本。', n: '早返回。', v: 'change' },
  { t: '为「${label}」补一条门关字节回退测试：关掉 KHY_* 门后行为逐字节回到改动前。', n: '门关回退。', v: 'flag' },
  { t: '给「${label}」仅用于匹配的正则去掉全局 g 标志，避免 lastIndex 状态残留。', n: '正则去 g。', v: 'area' },
  { t: '为「${label}」登记进 docs/_维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全）。', n: '登记映射表。', v: 'maint' },
  { t: '为「${label}」补一句「一句话验证脚本」并并入 test:maintainer:all。', n: '一句话验证。', v: 'maint' },
  { t: '检查「${label}」的错误信息是否可执行：告诉用户「下一步做什么」而不仅是「哪里错了」。', n: '可执行错误。', v: 'area' },
  { t: '为「${label}」的关键常量补注释解释「为什么是这个值」（保守高估、上限来源等）。', n: '常量讲来源。', v: 'change' },
  { t: '为「${label}」增加平台差异白名单（linux/windows/macos/android/ios），差异化规则收在注册表一处。', n: '平台白名单。', v: 'area' },
  { t: '为「${label}」补一条并发/竞态测试：同一资源被两条路径同时访问时结果仍正确。', n: '并发测试。', v: 'area' },
  { t: '把「${label}」里手写的重复逻辑抽成一个纯 helper，并给它单测。', n: '抽纯 helper。', v: 'leaf' },
  { t: '为「${label}」写一条「畸形输入绝不抛」的模糊测试：喂 null/数字/字符串/超大对象都返回安全值。', n: '模糊测试。', v: 'leaf' },
  { t: '检查「${label}」的默认值是否安全优先：不确定时偏向拒绝/降级而非放行。', n: '安全默认。', v: 'change' },
  { t: '为「${label}」补一条端点/URL 成形的确定性测试（不发真实请求，只断言拼出的字符串正确）。', n: 'URL 成形测试。', v: 'area' },
  { t: '为「${label}」的每个导出函数确认都有对应测试引用，无孤儿导出。', n: '无孤儿导出。', v: 'leaf' },
  { t: '为「${label}」增加预算/上限保护：循环或累积有明确终止条件，防止失控。', n: '预算护栏。', v: 'area' },
  { t: '把「${label}」的巨型 switch 按 case 簇抽子分派器（pre-dispatch + 哨兵 fall-through）。', n: 'switch 拆解。', v: 'arch' },
  { t: '为「${label}」补一条幂等测试：同一操作跑两次结果一致、无副作用叠加。', n: '幂等测试。', v: 'area' },
  { t: '检查「${label}」是否遵守单向依赖：叶子不得反向 require 宿主网关，需要就用 IoC 缝。', n: '单向依赖。', v: 'leaf' },
  { t: '为「${label}」写一份「新维护者一分钟上手」的结构表（文件→职责一行）。', n: '一分钟上手。', v: 'maint' },
  { t: '为「${label}」的时间相关逻辑改为「时钟由调用方喂入」，让它可离线确定性测试。', n: '时钟可注入。', v: 'area' },
  { t: '给「${label}」补一条「截断/采样时必须 log 丢了什么」的规则，杜绝静默截断。', n: '别静默截断。', v: 'change' },
  { t: '为「${label}」增加 dry-run 模式：先展示将要做什么，用户确认后才执行破坏性操作。', n: 'dry-run 先行。', v: 'safety' },
  { t: '检查「${label}」的 flag 语义：opt-in 严格只认 1/true，default-on 只认关键词才关。', n: '门语义核对。', v: 'flag' },
  { t: '为「${label}」补一条「父门关闭 → 子功能整体关闭」的门控测试。', n: '父子门控。', v: 'flag' },
  { t: '把「${label}」里的魔法数字提取为具名常量并注释其单位与来源。', n: '消魔法数。', v: 'change' },
  { t: '为「${label}」写一条向后兼容测试：旧输入格式仍能被正确解析。', n: '向后兼容。', v: 'area' },
  { t: '为「${label}」的注册表新增一维时，确认聚合器与格式化器各只改一处（不 smear）。', n: '改动不 smear。', v: 'area' },
  { t: '检查「${label}」抽取后宿主是否仍持有核心态，叶子只拿它需要的切片。', n: '核心态留宿主。', v: 'arch' },
  { t: '为「${label}」补一条跨渠道/双通道一致性测试（如版本号 pip 与 npm 必须一致）。', n: '双通道一致。', v: 'area' },
  { t: '为「${label}」的用户可见文案统一措辞与语气，避免同义词乱用误导弱模型。', n: '文案统一。', v: 'maint' },
  { t: '给「${label}」增加一个健康分自检项，纳入 khy doctor 的输出。', n: '并入自检。', v: 'doctor' },
  { t: '为「${label}」补一条资源清理测试：临时文件用后即删、句柄关闭、无泄漏。', n: '资源清理。', v: 'area' },
  { t: '把「${label}」里可能抛的第三方调用全部包进 try/catch 并给结构化 reason。', n: '结构化容错。', v: 'change' },
  { t: '为「${label}」写一条已知安全边界注释：明确它是 review aid 还是隔离边界，别夸大保证。', n: '诚实边界。', v: 'leaf' },
  { t: '为「${label}」补一条空结果早退路径：0 命中时跳过昂贵的下游步骤。', n: '空结果早退。', v: 'area' },
  { t: '检查「${label}」的命令别名是否都路由到正确 handler，补一条 alias 路由测试。', n: '别名路由。', v: 'area' },
  { t: '为「${label}」建立一条 memory 记录模板，把「为什么这么改」写进传承文档。', n: '沉淀传承。', v: 'maint' },
];

/**
 * 确定性构建 1000 条提示词。纯计算、无副作用、可幂等重跑。
 * 返回 { prompts:[{n,section,text,note,verify}], sections:string[], count }。
 */
function build() {
  const areas = loadAreas();
  const pool = [];

  const push = (section, text, note, verify) => {
    const v = isSafeVerify(verify) ? verify : VERIFY_KEYS.maint;
    pool.push({ section, text: String(text), note: String(note), verify: v });
  };

  // 第一篇：通用工作纪律与红线。
  for (const g of GENERAL) {
    push('一、通用工作纪律与红线（先读这一篇）', g.text, g.note, resolveVerify(g.v, null));
  }

  // 第二篇：各子系统定位与自检（whenToUse → 触发即读该子系统 + 跑其 verify）。
  for (const a of areas) {
    for (const w of a.whenToUse) {
      push(
        '二、各子系统定位与自检',
        `如果「${w}」，先读「${a.label}」相关文件（见 ${a.paths[0] || '维护映射表'}），按 B1 说清改什么，再跑其验证命令确认现状。`,
        `子系统：${a.label}。触发词命中时的第一反应。`,
        areaVerify(a)
      );
    }
  }

  // 第三篇：各子系统验证门（逐条 verify 命令即「这块没坏」的证据）。
  for (const a of areas) {
    for (const v of a.verify) {
      push(
        '三、各子系统验证门（一条命令＝一块的绿灯）',
        `验证「${a.label}」：跑该命令，绿灯才算这块没坏。`,
        `子系统：${a.label}。`,
        v
      );
    }
  }

  // 第四篇：逐文件理解（读每个真实文件，说清职责 + 补一句注释）。
  for (const a of areas) {
    for (const p of a.paths) {
      const v = p.endsWith('.js') ? `node --check ${p}` : areaVerify(a);
      push(
        '四、逐文件理解与补注释',
        `阅读「${a.label}」的 ${p}，用一句话说清它做什么，并给非显然逻辑补一句注释（勿改行为）。`,
        `子系统：${a.label}。读懂再动。`,
        isSafeVerify(v) ? v : areaVerify(a)
      );
    }
  }

  // 第五篇：进化配方 × 每个子系统（子系统无关的工程动作逐一落到真实 area）。
  for (const a of areas) {
    for (const r of RECIPES) {
      push(
        '五、进化配方（每个子系统都照做一遍）',
        r.t.replace('${label}', a.label),
        `${r.n} 子系统：${a.label}。`,
        resolveVerify(r.v, a)
      );
    }
  }

  // 第六篇：逐文件进化（补测试 / 查可读性 / 查密钥）——用来把总数补到 1000 以上。
  for (const a of areas) {
    for (const p of a.paths) {
      const checkV = p.endsWith('.js') ? `node --check ${p}` : areaVerify(a);
      push('六、逐文件进化', `为 ${p} 补一条 node:test（若已有则加一个未覆盖的边界用例）。`, `子系统：${a.label}。`, areaVerify(a));
      push('六、逐文件进化', `检查 ${p} 是否够弱模型维护：变量名自解释、无魔法数、关键分支有注释。`, `子系统：${a.label}。`, isSafeVerify(checkV) ? checkV : areaVerify(a));
      push('六、逐文件进化', `确认 ${p} 不含写死的真 key/token，敏感值只经 env 注入（只打印长度不打印值）。`, `子系统：${a.label}。`, VERIFY_KEYS.model);
    }
  }

  if (pool.length < TARGET_COUNT) {
    throw new Error(
      `生成池不足 ${TARGET_COUNT} 条（当前 ${pool.length}）。请往 GENERAL/RECIPES 补条目或确认维护映射表可读。`
    );
  }

  const sliced = pool.slice(0, TARGET_COUNT);
  const prompts = sliced.map((p, i) => ({ n: i + 1, ...p }));
  const sections = [];
  for (const p of prompts) {
    if (!sections.includes(p.section)) sections.push(p.section);
  }
  return { prompts, sections, count: prompts.length };
}

/** 生成手册头部（使用说明 + 红线 + 验证门速查 + 重生方法）。 */
function buildHeader(count) {
  return [
    '# [OPS-MAN-066] Khy-OS 进化提示词手册（1000 条）',
    '',
    '> 交给 khy 或任何「弱智 AI / 4B 小模型」用的进化清单：一次喂一条，照着做，跑通它自带的验证命令。',
    '> 全部锚定本仓真实子系统、真实文件、真实 verify（来自 `docs/_维护者/维护映射表.json`）。',
    '',
    '## 怎么用（给小模型的三步）',
    '',
    '1. 从下面挑一条提示词，把「说明」读懂，按 **B1**（先想清改什么/为什么/影响面）动手。',
    '2. 改完立刻跑该条的「验证」命令；红灯就在本轮修好，**没跑过验证不许说「修好了」**（B2）。',
    '3. 只动该动的（**B3** 外科手术式改动），绿了再挑下一条。',
    '',
    '## 红线（破了就停，不许绕）',
    '',
    '- **禁止 AI 自动 commit / push**：任何提交都要人明确点头。',
    '- **禁止把真 key/token 写进源码/包/提交**：只经 env 注入，日志只打印长度不打印明文；**禁贴 key 到对话**。',
    '- **单文件不得新增超 2500 行**：超了按 god-file 治理（同名 re-export + DI，保字节等价）。',
    '- **pip 与 npm 版本号必须一致**。',
    '',
    '## 通用验证门速查（收尾五门，全绿才算完成）',
    '',
    '```bash',
    'node --check <改动的每个 .js 文件>      # 语法',
    'node --test <相关 node:test 文件>       # 逻辑（勿用 jest 前缀）',
    'npm run arch:god                       # 改动文件不得新增超 2500 行（在 services/backend 下跑）',
    'npm run check:small-model:safety       # 五守卫合集（新叶子须显式传路径扫）',
    'npm run maintainer:check               # 维护映射表 + 元数据一致',
    '```',
    '',
    '## 手册如何重生（系统长大后）',
    '',
    '本手册由生成器确定性产出，改子系统后重跑即可覆盖：',
    '',
    '```bash',
    'npm run docs:gen-evolution-prompts     # 重新生成本文件',
    'npm run test:evolution-prompts         # 校验恰好 ' + count + ' 条、每条带安全 verify、幂等',
    '```',
    '',
    '> 新增子系统请先登记进 `docs/_维护者/维护映射表.json`，本手册下次重生会自动覆盖它。',
    '',
    `**共 ${count} 条。**`,
    '',
    '---',
    '',
  ].join('\n');
}

/** 把 build() 结果渲染为 Markdown 全文。 */
function toMarkdown() {
  const { prompts, count } = build();
  const lines = [buildHeader(count)];
  let currentSection = null;
  for (const p of prompts) {
    if (p.section !== currentSection) {
      currentSection = p.section;
      lines.push('');
      lines.push(`## ${currentSection}`);
      lines.push('');
    }
    lines.push(`**${p.n}.** ${p.text}`);
    lines.push(`  - 说明：${p.note}`);
    lines.push('  - 验证：`' + p.verify + '`');
    lines.push('');
  }
  return lines.join('\n');
}

function writeDoc() {
  const md = toMarkdown();
  fs.writeFileSync(DOC_PATH, md, 'utf8');
  return { path: DOC_PATH, bytes: Buffer.byteLength(md, 'utf8') };
}

module.exports = {
  build,
  toMarkdown,
  writeDoc,
  isSafeVerify,
  VERIFY_KEYS,
  DANGER_TOKENS,
  TARGET_COUNT,
  DOC_PATH,
};

if (require.main === module) {
  const res = writeDoc();
  const { count } = build();
  // eslint-disable-next-line no-console
  console.log(`OK 写出 ${count} 条 → ${path.relative(ROOT, res.path)} (${res.bytes} bytes)`);
}
