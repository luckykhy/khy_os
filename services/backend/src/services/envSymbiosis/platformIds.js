'use strict';

/**
 * platformIds.js — 环境共生引擎的「平台身份与原生拓扑」单一真源（§3.2 / §3.3）。
 *
 * 环境共生哲学：核心意图统一、执行路径分裂。本表是「分裂」的唯一权威——任何平台差异都
 * 必须收口到这里，绝不允许散落在底层执行模块里用 Polyfill 抹平（防呆①）。三份只读地图：
 *
 *   PLATFORM         五大环境的规范身份（env_scope 取值来源）。
 *   NATIVE_TOPOLOGY  每个环境的「原生长板拓扑」——该环境进化特长的方向（§3.2）。
 *   AFFINITY_TABLE   核心意图 → 各环境最锋利原生执行路径（§3.3）。缺位即「器官空洞」，
 *                    交由淬火器升维出该环境的新原生器官，绝不退回通用低效 API。
 *
 * 纯数据 + 纯函数，无 I/O、无状态——保证「核心状态机跨平台一致」（防呆④）：同一意图 +
 * 同一指纹，在任何宿主机上路由结果完全一致，差异只体现在被选中的原生工具字符串上。
 */

/** 五大环境的规范身份。值即 EvoRequirement.env_scope 的取值（防呆②）。 */
const PLATFORM = Object.freeze({
  LINUX: 'Linux',
  WINDOWS: 'Windows',
  MACOS: 'macOS',
  ANDROID: 'Android',
  HARMONY: 'HarmonyOS',
});

const _ALL_PLATFORMS = Object.freeze(Object.values(PLATFORM));

/**
 * 内核指纹标识：把运行时探针读到的内核/运行时特征归一到 PLATFORM（§3.1 内核指纹）。
 * 每条：{ platform, kernel, match(probe) } —— match 仅依赖注入的 probe（确定性、可测）。
 */
const KERNEL_SIGNATURES = Object.freeze([
  { platform: PLATFORM.HARMONY, kernel: 'ArkTS/OHOS', match: (p) => /harmony|ohos|arkts/i.test(`${p.osType} ${p.runtime}`) },
  { platform: PLATFORM.ANDROID, kernel: 'Linux/Bionic(Android)', match: (p) => /android/i.test(`${p.osType} ${p.runtime}`) || p.isAndroid === true },
  { platform: PLATFORM.MACOS, kernel: 'XNU(Darwin)', match: (p) => p.nodePlatform === 'darwin' },
  { platform: PLATFORM.WINDOWS, kernel: 'Win32 NT', match: (p) => p.nodePlatform === 'win32' },
  { platform: PLATFORM.LINUX, kernel: 'Linux Kernel', match: (p) => p.nodePlatform === 'linux' },
]);

/**
 * 原生长板拓扑（§3.2）：每个环境「该往哪个方向长特长」的能力图谱。
 * 不是当前已实现的工具清单，而是淬火器升维器官时的方向指引（proposedModules 取材于此）。
 */
const NATIVE_TOPOLOGY = Object.freeze({
  [PLATFORM.WINDOWS]: Object.freeze(['COM自动化', 'WMI系统管控', '注册表深度干预', 'Office生态互操作']),
  [PLATFORM.LINUX]: Object.freeze(['eBPF内核级监控', 'Cgroup资源隔离', 'Shell管道极速编排', '系统级守护进程(Daemon)化']),
  [PLATFORM.MACOS]: Object.freeze(['AppleScript/Shortcuts生态闭环', 'Swift原生桥接', '沙箱内安全合规操作']),
  [PLATFORM.ANDROID]: Object.freeze(['无障碍服务UiAutomator', 'Intent隐式调用跨应用', '低功耗后台保活', '传感器直读']),
  [PLATFORM.HARMONY]: Object.freeze(['分布式软总线设备发现', '元服务免安装调用', 'ArkTS原生并发模型']),
});

/**
 * 原生亲和路由表（§3.3）：核心意图 → 各环境最优原生执行路径。
 * 每个意图条目按 PLATFORM 键给出 { tool, kind, fallback? }：
 *   tool      该环境上最锋利的原生工具/接口（执行路径分裂的落点）
 *   kind      执行族（cli / api / native-bridge / kernel-probe …），供执行层选择派发方式
 *   fallback  同环境内的退而求其次原生手段（仍是该环境原生，非跨平台 Polyfill）
 * 某意图在某环境缺位（undefined）= 该环境的「器官空洞」，触发兼容性淬火长出新原生器官。
 */
const AFFINITY_TABLE = Object.freeze({
  open_url: Object.freeze({
    [PLATFORM.LINUX]: { tool: 'xdg-open', kind: 'cli' },
    [PLATFORM.MACOS]: { tool: 'open', kind: 'cli' },
    [PLATFORM.WINDOWS]: { tool: 'start', kind: 'cli' },
    [PLATFORM.ANDROID]: { tool: 'Intent.ACTION_VIEW', kind: 'native-bridge' },
    [PLATFORM.HARMONY]: { tool: 'Ability.startAbility', kind: 'native-bridge' },
  }),
  monitor_process: Object.freeze({
    [PLATFORM.LINUX]: { tool: 'eBPF', kind: 'kernel-probe', fallback: '/proc 解析' },
    [PLATFORM.WINDOWS]: { tool: 'WMI(Win32_Process)', kind: 'api' },
    [PLATFORM.MACOS]: { tool: 'sysctl(KERN_PROC)', kind: 'api', fallback: 'ps via Automation' },
    [PLATFORM.ANDROID]: { tool: '/proc 解析', kind: 'cli' },
    [PLATFORM.HARMONY]: { tool: 'HiDumper/分布式任务管理', kind: 'native-bridge' },
    // 注：某环境若此处缺位，即器官空洞 → 淬火新生，绝不回退到跨平台统一进程 API（防呆①）。
  }),
});

/** 一个意图的全平台亲和子表（未知意图 → null）。 */
function affinityFor(intent) {
  return Object.prototype.hasOwnProperty.call(AFFINITY_TABLE, intent) ? AFFINITY_TABLE[intent] : null;
}

/** 是否已知平台身份。 */
function isPlatform(p) {
  return _ALL_PLATFORMS.includes(p);
}

/** 该环境的原生长板拓扑（未知 → 空数组）。 */
function topologyFor(platform) {
  return NATIVE_TOPOLOGY[platform] || [];
}

module.exports = {
  PLATFORM,
  KERNEL_SIGNATURES,
  NATIVE_TOPOLOGY,
  AFFINITY_TABLE,
  affinityFor,
  isPlatform,
  topologyFor,
  _ALL_PLATFORMS,
};
