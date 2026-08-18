'use strict';

/**
 * pythonAvailable.js — 「本机可运行 python」共享探活 helper(带 TTL 缓存)。
 *
 * 收敛 3 处 body 逐字节/逐逻辑相同的私有 python 探测——
 *   utils/docHelperEnabled.js(prefer python3 后 python)·tools/createDocument.js·tools/renderDocument.js。
 * 三文件各自还额外检查「各自关心的脚本是否存在」(docHelper.py / docTypeset.py),那部分属于
 * 消费方特有,留在调用点(见下方契约)——本 helper 只拥有「python 可运行」这一共性事实。
 *
 * 语义:试 `python3 --version`(3s 超时)成功 → true;否则试 `python --version` → true;
 *   均失败 → false。**绝不抛**。
 *
 * 性能:探测会 spawn 子进程(~100-300ms)。实测简单打招呼的一轮会调用到本探测 6 次
 *   (getEnabled() 对 createDocument/renderDocument/convertFile 等逐个 isEnabled);不加缓存
 *   就是 6 次阻塞 spawn。这里以 `_CHECK_TTL_MS = 60000` 缓存 60s:同一进程内一轮(及相邻轮)
 *   只探活一次,命中直接返回。
 *
 * 契约:非纯(fs·execFileSync spawn python)·fail-soft·TTL 缓存。消费方自行组合自身脚本
 *   的存在性检查(如 `fs.existsSync(DOC_HELPER) && require('../utils/pythonAvailable')()`)。
 */

const { execFileSync } = require('child_process');

const _CHECK_TTL_MS = 60000;
let _cache = { value: false, at: 0 };

function pythonAvailable() {
  const now = Date.now();
  if (_cache.at && now - _cache.at < _CHECK_TTL_MS) {
    return _cache.value;
  }
  _cache = { value: _probe(), at: now };
  return _cache.value;
}

function _probe() {
  for (const py of ['python3', 'python']) {
    try {
      execFileSync(py, ['--version'], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

module.exports = pythonAvailable;
