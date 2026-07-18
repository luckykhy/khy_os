'use strict';

/**
 * extensionWriter.js — 模型自主 DIY 落地写入（任务三 · 模型自适应 · 红线5 沙箱边界）。
 *
 * 允许用户的 AI 模型在**获得授权**后，于运行时把适配脚本 / Bug 修复补丁写入用户扩展轨。
 * 两道铁闸：
 *   - 授权闸（AuthorizationRequiredError）：authorized !== true 一律拒绝——模型 DIY 必须
 *     经用户显式授权，**绝不**默许自写。
 *   - 沙箱闸（CorePollutionError）：写入路径必须落在用户扩展轨内，指向官方核心轨或轨外
 *     一律拒绝——**绝不**允许模型修改官方核心源文件（红线5）。
 */

const nodePath = require('path');
const { CorePollutionError } = require('./actionRegistry');
const { assertWithinUserTrack } = require('./extensionLoader');

class AuthorizationRequiredError extends Error {
  constructor(message) { super(message); this.name = 'AuthorizationRequiredError'; this.code = 'AUTHORIZATION_REQUIRED'; }
}

/**
 * 把模型生成的扩展代码写入用户扩展轨。
 *
 * @param {{userTrackRoot, relPath, content, authorized, fs?, pathImpl?}} opts
 * @returns {{ written:string }} 写入的绝对路径
 */
function writeUserExtension(opts = {}) {
  const {
    userTrackRoot,
    relPath,
    content,
    authorized,
    fs = require('fs'),
    pathImpl = nodePath,
  } = opts;

  if (authorized !== true) {
    throw new AuthorizationRequiredError('模型 DIY 写入必须经用户显式授权（authorized=true）');
  }
  if (!userTrackRoot) throw new Error('writeUserExtension: 缺少 userTrackRoot');
  if (typeof relPath !== 'string' || !relPath) throw new Error('writeUserExtension: relPath 必须为非空字符串');
  if (typeof content !== 'string') throw new Error('writeUserExtension: content 必须为字符串');

  // 沙箱边界：解析后必须仍在用户轨内（红线5）。
  const abs = assertWithinUserTrack(relPath, userTrackRoot, pathImpl);

  const dir = pathImpl.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { written: abs };
}

module.exports = { writeUserExtension, AuthorizationRequiredError, CorePollutionError };
