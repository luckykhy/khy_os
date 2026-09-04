'use strict';

/**
 * @pattern Flyweight, Memento
 *
 * checkpointObjectStore.js — checkpoint 载荷的内容寻址对象库（CAS）。
 *
 * 布局 `objects/sha256/<前两位>/<digest>.gz`。同一份内容只落一份：现场 5 个项目
 * 21 个 checkpoint 共 193 MB，而其中大量 patch/tar 内容是重复的——按内容寻址后
 * 相同载荷天然合并，这就是 KHY_CHECKPOINT_STORAGE_MODE=cas 的全部收益来源。
 *
 * 四条不显然但都是硬要求的性质：
 *
 *   1. **digest 先验证再拼路径**。digest 来自 manifest，而 manifest 可能是旧版本
 *      写的、也可能是从别处拷来的目录里的。不校验就拼路径等于把 `../../` 交给
 *      文件系统。因此 objectPath 对非 64 位小写十六进制**直接抛**，不做兜底。
 *   2. **写一次**。目标已存在就不重写：内容寻址下「已存在」意味着字节完全相同，
 *      重写只会把一份完好的对象暴露在一次可中断的写入里。
 *   3. **临时名 + rename**；rename 失败但目标已存在时**视为成功**——那是另一个
 *      进程用同样的内容赢了竞态，而按定义它写进去的字节和我们要写的一模一样。
 *   4. **读时校验 digest 和 size**。对象是压缩的，静默损坏不会在 gunzip 时报错，
 *      而一份能解压但内容不对的 checkpoint 恢复出来看起来完全正常——这是最坏的
 *      失败形态，所以宁可在这里抛。
 *
 * 边界：`removeIfUnreferenced` 只删调用方**已经证明无引用**的 digest，本模块自己
 * 不扫 manifest。引用判定必须看全量 manifest（一个对象可被多个 entry 引用），
 * 按 mtime 或按「删这条 entry 就删它的对象」都会删掉仍在用的内容。
 *
 * @module services/workspace/checkpointObjectStore
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function digestBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function objectPath(root, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('Invalid checkpoint object digest');
  }
  return path.join(root, 'objects', 'sha256', digest.slice(0, 2), digest + '.gz');
}

function putBuffer(root, buffer) {
  const digest = digestBuffer(buffer);
  const target = objectPath(root, digest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    const temporary = target + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(temporary, zlib.gzipSync(buffer));
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      if (!fs.existsSync(target)) throw error;
    }
  }
  return { digest, size: buffer.length, encoding: 'gzip' };
}

function readBuffer(root, object) {
  const compressed = fs.readFileSync(objectPath(root, object.digest));
  const buffer = zlib.gunzipSync(compressed);
  if (digestBuffer(buffer) !== object.digest) {
    throw new Error('Checkpoint object digest mismatch');
  }
  if (Number.isFinite(object.size) && buffer.length !== object.size) {
    throw new Error('Checkpoint object size mismatch');
  }
  return buffer;
}

function removeIfUnreferenced(root, digests) {
  let removed = 0;
  for (const digest of digests) {
    const target = objectPath(root, digest);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed++;
      }
    } catch { /* best effort */ }
  }
  return removed;
}

module.exports = { digestBuffer, putBuffer, readBuffer, removeIfUnreferenced, objectPath };
