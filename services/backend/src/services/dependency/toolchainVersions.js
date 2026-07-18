'use strict';

/**
 * dependency/toolchainVersions.js — 「按客户需求选版本」的工具链版本矩阵(单一真源)。
 *
 * 纯叶子:零 IO、确定性、绝不抛、单一真源。env 门控 KHY_DEP_VERSIONS(默认开,
 * 仅 {0,false,off,no} 关 → 关时一切解析返回 null,buildInstallPlan 字节回退到
 * registry 写死的默认版本)。
 *
 * 背景:dependency/registry.js 每个工具链只登记**一个写死的版本**
 * (openjdk → Temurin 21 / apt default-jdk)。但客户开发项目时常需要**特定版本**
 * (历史项目要 JDK 8、某框架要 JDK 17、Python 3.11、.NET 6)。本表把
 * 「(depId, version, platform) → 安装 argv」收敛为单一真源,使
 * `khy deps install openjdk@17` / 自愈层在已知版本时都能按需取版。
 *
 * 设计红线(与 registry 一致):
 *   - 安装 argv 全为 **curated 字面量**,绝不取自模型输入 / 报错文本 → 杜绝命令注入。
 *   - version 经**白名单**校验:只接受本表已登记的版本字符串;任意 / 非法版本一律
 *     返回 null(退回 registry 默认),绝不把外来字符串拼进命令。
 *   - 平台差异(apt / brew / winget)收敛在每个版本条目里;某平台无干净的按版本包
 *     时该平台键缺省 → 返回 null(诚实降级,由上层提示「该平台无预置版本映射」)。
 */

// 门控关字面量(与其余纯叶子一致)。
const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * 版本可选工具链矩阵。键为 registry 中的稳定 depId(与 registry.js 对齐),
 * 每个版本条目给出三平台的 curated argv:
 *   linux  → apt-get   darwin → brew   win32 → winget
 * 缺某平台键 = 该平台无干净的按版本包(诚实留空,解析返 null → 退回默认)。
 */
const MATRIX = {
  openjdk: {
    label: 'OpenJDK (javac / java)',
    aliases: ['jdk', 'java', 'javac', 'openjdk'],
    default: '21',
    versions: {
      8: {
        linux: ['apt-get', 'install', '-y', 'openjdk-8-jdk'],
        darwin: ['brew', 'install', 'openjdk@8'],
        win32: ['winget', 'install', '--id', 'EclipseAdoptium.Temurin.8.JDK', '-e'],
      },
      11: {
        linux: ['apt-get', 'install', '-y', 'openjdk-11-jdk'],
        darwin: ['brew', 'install', 'openjdk@11'],
        win32: ['winget', 'install', '--id', 'EclipseAdoptium.Temurin.11.JDK', '-e'],
      },
      17: {
        linux: ['apt-get', 'install', '-y', 'openjdk-17-jdk'],
        darwin: ['brew', 'install', 'openjdk@17'],
        win32: ['winget', 'install', '--id', 'EclipseAdoptium.Temurin.17.JDK', '-e'],
      },
      21: {
        linux: ['apt-get', 'install', '-y', 'openjdk-21-jdk'],
        darwin: ['brew', 'install', 'openjdk@21'],
        win32: ['winget', 'install', '--id', 'EclipseAdoptium.Temurin.21.JDK', '-e'],
      },
    },
  },
  python3: {
    label: 'Python 3 运行时',
    aliases: ['python', 'python3', 'py'],
    default: '3.12',
    versions: {
      '3.10': {
        linux: ['apt-get', 'install', '-y', 'python3.10'],
        darwin: ['brew', 'install', 'python@3.10'],
        win32: ['winget', 'install', '--id', 'Python.Python.3.10', '-e'],
      },
      '3.11': {
        linux: ['apt-get', 'install', '-y', 'python3.11'],
        darwin: ['brew', 'install', 'python@3.11'],
        win32: ['winget', 'install', '--id', 'Python.Python.3.11', '-e'],
      },
      '3.12': {
        linux: ['apt-get', 'install', '-y', 'python3.12'],
        darwin: ['brew', 'install', 'python@3.12'],
        win32: ['winget', 'install', '--id', 'Python.Python.3.12', '-e'],
      },
      '3.13': {
        linux: ['apt-get', 'install', '-y', 'python3.13'],
        darwin: ['brew', 'install', 'python@3.13'],
        win32: ['winget', 'install', '--id', 'Python.Python.3.13', '-e'],
      },
    },
  },
  dotnet: {
    label: '.NET SDK (dotnet / csc)',
    aliases: ['dotnet', 'net', '.net'],
    default: '8',
    versions: {
      // brew 无干净的按主版本 cask → darwin 键缺省(返回 null,退回 registry 默认 dotnet-sdk)。
      6: {
        linux: ['apt-get', 'install', '-y', 'dotnet-sdk-6.0'],
        win32: ['winget', 'install', '--id', 'Microsoft.DotNet.SDK.6', '-e'],
      },
      7: {
        linux: ['apt-get', 'install', '-y', 'dotnet-sdk-7.0'],
        win32: ['winget', 'install', '--id', 'Microsoft.DotNet.SDK.7', '-e'],
      },
      8: {
        linux: ['apt-get', 'install', '-y', 'dotnet-sdk-8.0'],
        win32: ['winget', 'install', '--id', 'Microsoft.DotNet.SDK.8', '-e'],
      },
      9: {
        linux: ['apt-get', 'install', '-y', 'dotnet-sdk-9.0'],
        win32: ['winget', 'install', '--id', 'Microsoft.DotNet.SDK.9', '-e'],
      },
    },
  },
};

/** 门控:KHY_DEP_VERSIONS 默认开,仅显式关字面量关闭。 */
function isEnabled(env = process.env) {
  const v = env && env.KHY_DEP_VERSIONS;
  if (v === undefined || v === null || v === '') return true;
  return !OFF.has(String(v).trim().toLowerCase());
}

/** 把别名 / 大小写归一到 canonical depId;未知则原样小写返回(供调用方继续查 registry)。 */
function resolveDepId(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  if (MATRIX[n]) return n;
  for (const depId of Object.keys(MATRIX)) {
    const aliases = MATRIX[depId].aliases || [];
    if (aliases.some((a) => a.toLowerCase() === n)) return depId;
  }
  return n;
}

/**
 * 解析 `depId[@version]` 规格(如 'openjdk@17' / 'jdk@8' / 'python3')。绝不抛。
 * 别名经 resolveDepId 归一;version 保留原样(白名单校验留给 resolveVersionedCommand)。
 * @param {string} spec
 * @returns {{ depId:string, version:(string|null) }}
 */
function parseDepSpec(spec) {
  const s = String(spec || '').trim();
  if (!s) return { depId: '', version: null };
  const at = s.indexOf('@');
  if (at < 0) return { depId: resolveDepId(s), version: null };
  const rawId = s.slice(0, at);
  const rawVer = s.slice(at + 1).trim();
  return { depId: resolveDepId(rawId), version: rawVer || null };
}

/** 该 depId 是否登记了按版本安装(canonical 或别名均可)。 */
function isVersionable(depId) {
  return !!MATRIX[resolveDepId(depId)];
}

/** 某工具链支持的版本字符串列表(声明顺序);非版本可选返回 []。 */
function supportedVersions(depId) {
  const entry = MATRIX[resolveDepId(depId)];
  if (!entry) return [];
  return Object.keys(entry.versions);
}

/** 某工具链的默认版本(无则 null)。 */
function defaultVersion(depId) {
  const entry = MATRIX[resolveDepId(depId)];
  return entry ? (entry.default || null) : null;
}

/** 列出全部版本可选工具链(供 CLI 陈述)。纯函数,返回新数组。 */
function listVersionable() {
  return Object.keys(MATRIX).map((depId) => ({
    depId,
    label: MATRIX[depId].label,
    aliases: (MATRIX[depId].aliases || []).slice(),
    versions: Object.keys(MATRIX[depId].versions),
    default: MATRIX[depId].default || null,
  }));
}

/**
 * 解析「(depId, version, platform) → 安装 argv」。绝不抛。返回 null 表示「无按版本映射,
 * 退回 registry 默认」,触发条件:
 *   - 门控关(KHY_DEP_VERSIONS off)→ 字节回退;
 *   - depId 非版本可选;
 *   - version 不在白名单(任意 / 非法字符串绝不入命令);
 *   - 该平台无干净的按版本包(平台键缺省)。
 * @param {object} args
 * @param {string} args.depId
 * @param {string} args.version
 * @param {string} [args.platform=process.platform]
 * @param {object} [args.env=process.env]
 * @returns {string[]|null} curated argv 的**防御性拷贝**(调用方不可改写本表原数组)。
 */
function resolveVersionedCommand(args = {}) {
  const env = args.env || process.env;
  if (!isEnabled(env)) return null;
  const depId = resolveDepId(args.depId);
  const entry = MATRIX[depId];
  if (!entry) return null;
  const version = String(args.version == null ? '' : args.version).trim();
  if (!version) return null;
  // 白名单校验:只接受已登记版本键(绝不把外来字符串拼进命令)。
  if (!Object.prototype.hasOwnProperty.call(entry.versions, version)) return null;
  const platform = args.platform || process.platform;
  const byPlat = entry.versions[version];
  const argv = byPlat && byPlat[platform];
  if (!Array.isArray(argv) || argv.length === 0) return null;
  return argv.slice();
}

/** describe:供 `khy deps` / 文档陈述的版本矩阵正本(纯数据快照)。 */
function describeVersions() {
  return {
    gate: 'KHY_DEP_VERSIONS',
    enabled: isEnabled(process.env),
    note: '安装命令均为 curated 字面量(apt/brew/winget),版本经白名单校验;非法版本退回默认,绝不拼接外来字符串。',
    toolchains: listVersionable(),
  };
}

module.exports = {
  OFF,
  MATRIX,
  isEnabled,
  resolveDepId,
  parseDepSpec,
  isVersionable,
  supportedVersions,
  defaultVersion,
  listVersionable,
  resolveVersionedCommand,
  describeVersions,
};
