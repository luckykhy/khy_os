'use strict';

/**
 * learningProfile.js — 学习者「讲解档位」持久化（零基础 / 常规）
 *
 * 诉求：用户是「三零基础」（不懂编程语言/算法/Agent 概念），希望 KHY 在讲解时逐行解释语法、
 * 解释「这门语言为什么这样写」。本模块只持久化一个**档位**（level），由 learn.js 透传给课程
 * prompt builder 决定是否追加「零基础讲解块」。
 *
 * 数据落**底座领地** `~/.khyos/growth/learn_profile.json`（与学习进度同主权域，随 pip 升级不丢），
 * 复用 learningCurriculum._saveProgress 的原子写 + .bak 惯例。
 *
 * 铁律：纯函数、fail-soft（读写任何异常都不抛、回落默认 'normal'）、零硬编码（默认走 KHY_LEARN_LEVEL）。
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../utils/dataHome');

const PROFILE_VERSION = 1;
const LEVELS = ['normal', 'beginner'];
const DEFAULT_LEVEL = 'normal';

// 收敛到 utils/growthDataDir 单一真源(逐字节委托,调用点不变) // ~/.khyos/growth
const _profileDir = require('../utils/growthDataDir');
function _profileFile() { return path.join(_profileDir(), 'learn_profile.json'); }
function _profileBak() { return path.join(_profileDir(), 'learn_profile.bak'); }

/** 环境默认档位：仅当磁盘上没有档位文件时生效。非法值忽略 → 'normal'。 */
function _envLevel() {
  const v = String(process.env.KHY_LEARN_LEVEL || '').trim().toLowerCase();
  return LEVELS.includes(v) ? v : DEFAULT_LEVEL;
}

function _normalizeLevel(level) {
  const v = String(level == null ? '' : level).trim().toLowerCase();
  return LEVELS.includes(v) ? v : null;
}

/** 读档位文件；缺失/损坏 → null（交由调用方回落 env/默认）。绝不抛。 */
function _readProfileFile() {
  try {
    const file = _profileFile();
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    const level = _normalizeLevel(raw.level);
    return {
      version: Number(raw.version) || PROFILE_VERSION,
      level: level || DEFAULT_LEVEL,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch {
    return null;   // 损坏 / 不可读 → 视为不存在
  }
}

/** 返回完整档位对象（文件优先 → 环境默认）。fail-soft，永不抛。 */
function loadProfile() {
  const onDisk = _readProfileFile();
  if (onDisk) return onDisk;
  return { version: PROFILE_VERSION, level: _envLevel(), updatedAt: null };
}

/** 当前档位 'beginner' | 'normal'。最坏回落 'normal'，绝不抛。 */
function getLevel() {
  try { return loadProfile().level; } catch { return DEFAULT_LEVEL; }
}

function isBeginner() { return getLevel() === 'beginner'; }

/**
 * 设置档位并持久化（原子写 + .bak 轮转）。
 * @returns {{ok:true, level:string} | {ok:false, error:string}}
 */
function setLevel(level) {
  const norm = _normalizeLevel(level);
  if (!norm) return { ok: false, error: `invalid level; choose ${LEVELS.join(' | ')}` };
  try {
    const dir = _profileDir();           // getBaseDataDir 已确保目录存在
    const file = _profileFile();
    // 写前轮转单份备份，损坏时可回退
    try { if (fs.existsSync(file)) fs.copyFileSync(file, _profileBak()); } catch { /* best-effort */ }
    const payload = { version: PROFILE_VERSION, level: norm, updatedAt: new Date().toISOString() };
    // 原子写：同目录临时文件 + rename（同卷 rename 原子，避免半写损坏）
    const tmp = path.join(dir, `.learn_profile.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    return { ok: true, level: norm };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'write_failed' };
  }
}

module.exports = {
  LEVELS,
  DEFAULT_LEVEL,
  loadProfile,
  getLevel,
  isBeginner,
  setLevel,
};
