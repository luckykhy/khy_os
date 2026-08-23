/**
 * buildDepsCleanup.mjs — 嵌入式构建工具链的「用完即走」清理器。
 *
 * 背景（实测数字）：仓库里有两条为了产出十几 MB 而装三百 MB 的工具链
 *   extensions/tools/khy-markdown/muya-embed/node_modules  182.3 MB → vendor/ 约 11 MB
 *   scripts/docs/mermaid-embed/node_modules                127.7 MB → mermaid.min.js 约 3.3 MB
 * 两份产物本来就是「不跟踪、按需重建」的（见 .gitignore 可再生构建产物段），
 * 那这 310 MB 的安装树在产出之后就没有留存价值了。
 *
 * 三条纪律：
 *   1. **只在真的构建成功之后清**。isReady() 短路那条路上一次构建都没跑，
 *      悄悄删掉别人现成的安装树是越权 —— 那种情况只打印提示，交给 khy clean 显式处理。
 *   2. **必须可逆**。清理前后都打印重建命令，被删的东西一条命令就能回来。
 *   3. **fail-soft**。清理是优化，不是产出。删不掉（Windows 上文件被占用最常见）
 *      只警告，绝不把一次成功的构建反过来判成失败。
 *
 * 开关：KHY_KEEP_BUILD_DEPS=1 保留安装树（反复改 build.mjs 时不用重装依赖）。
 *
 * @pattern Strategy
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/** 是否保留构建依赖（默认清理）。 */
export function shouldKeepBuildDeps(env = process.env) {
  return TRUTHY.has(String((env && env.KHY_KEEP_BUILD_DEPS) || '').trim().toLowerCase());
}

/** 目录字节数 + 文件数。符号链接不跟随；数不出来就返回 null，宁可不报数字也不报错数字。 */
export function measureTree(dir) {
  if (!existsSync(dir)) return null;
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    let entries;
    const current = stack.pop();
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += statSync(full).size;
          files += 1;
        } catch {
          /* 遍历途中文件消失：跳过 */
        }
      }
    }
  }
  return { bytes, files };
}

/** 1024 进制、一位小数，与 scripts/lib/storageBaseline.js 的 formatBytes 同口径。 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return (i === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[i];
}

/**
 * 构建成功后清掉自己的 node_modules。
 *
 * @param {object} args
 * @param {string} args.dir 工具链目录（其下的 node_modules 是清理对象）
 * @param {string} args.label 日志前缀，例如 'ensure-vendor'
 * @param {string} args.rebuildCommand 重建命令原文（必须能直接粘贴执行）
 * @param {boolean} [args.built] 本次是否真的跑过构建。false 时只提示不删。
 * @param {object} [args.env]
 * @param {function} [args.log] 注入用（默认 console.log）
 * @param {function} [args.warn] 注入用（默认 console.warn）
 * @returns {{cleaned:boolean, reason:string, reclaimedBytes:number, status:string}}
 */
export function cleanBuildDeps(args = {}) {
  const dir = String(args.dir || '');
  const label = String(args.label || 'build-deps');
  const rebuild = String(args.rebuildCommand || '');
  const log = typeof args.log === 'function' ? args.log : console.log;
  const warn = typeof args.warn === 'function' ? args.warn : console.warn;
  const target = join(dir, 'node_modules');

  const say = (text) => {
    log('[' + label + '] ' + text);
    return text;
  };

  if (!existsSync(target)) {
    return { cleaned: false, reason: 'absent', reclaimedBytes: 0, status: '' };
  }

  const before = measureTree(target);
  const size = before ? formatBytes(before.bytes) : '未能测量';
  const count = before ? before.files : 0;

  if (shouldKeepBuildDeps(args.env)) {
    return {
      cleaned: false,
      reason: 'kept',
      reclaimedBytes: 0,
      status: say('保留构建依赖 node_modules：' + size + ' / ' + count + ' 个文件（KHY_KEEP_BUILD_DEPS 已设）'),
    };
  }

  // 没跑构建就不动别人现成的安装树：那是开发者自己装的，删它属于越权。
  if (args.built === false) {
    return {
      cleaned: false,
      reason: 'no-build-ran',
      reclaimedBytes: 0,
      status: say(
        '跳过清理构建依赖：本次未构建，node_modules 仍占 ' + size + '，可用 khy clean --deps 显式回收（重建：' + rebuild + '）'
      ),
    };
  }

  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (err) {
    return {
      cleaned: false,
      reason: 'rm-failed',
      reclaimedBytes: 0,
      error: (err && err.message) || String(err),
      status: (warn(
        '[' + label + '] 清理构建依赖失败：' + ((err && err.message) || err) + '，保留 ' + size + ' 不影响已产出的产物'
      ), ''),
    };
  }

  return {
    cleaned: true,
    reason: 'cleaned',
    reclaimedBytes: before ? before.bytes : 0,
    status: say('清理构建依赖 node_modules：回收 ' + size + ' / ' + count + ' 个文件，需要时用 `' + rebuild + '` 重建'),
  };
}
