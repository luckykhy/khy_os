'use strict';

/**
 * _sseTextDecoder.js — 跨 chunk 边界安全的流式 UTF-8 解码器(纯叶子)。
 *
 * 根因(修复目标):HTTP 流的 `data` 事件按**字节**切块,一个多字节 UTF-8 字符
 * (中文 = 3 字节、emoji = 4 字节)常在两个 chunk 的边界处被劈开。直接
 * `chunk.toString()` 会把首块尾部**不完整的字节序列**解码成 U+FFFD 替换字符
 * (终端渲染为「◆」),下一块的续接字节同样变成 U+FFFD——一旦解码,原始字节即丢失,
 * 后续字符串拼接**无法修复**。这正是「说明◆◆求真实」这类乱码的来源。
 *
 * 修法:用 Node 内置 `string_decoder.StringDecoder`,它把每块尾部不完整的多字节
 * 序列**留存**到下一块再拼齐后解码,只有流真正结束时残留的半个字符才会退化为 U+FFFD
 * (那是上游截断,已不可救)。每个流实例持有独立解码器(有状态),故用工厂函数。
 *
 * 纯叶子:无网络/文件/子进程 IO、无随机、无时钟;仅包裹标准库解码器 + 输入类型守卫。
 * 这是**正确性修复而非可开关特性**——关掉即等于重新引入数据损坏,故不设门控/不做字节回退。
 */

const { StringDecoder } = require('string_decoder');

/**
 * 创建一个流式 UTF-8 文本解码器。为单个流的整个生命周期使用同一个实例,
 * 使不完整的多字节序列能跨 chunk 边界拼齐。
 * @returns {{ write(chunk:any):string, end():string }}
 */
function createSseTextDecoder() {
  const decoder = new StringDecoder('utf8');
  return {
    /**
     * 解码一个数据块。Buffer 走 StringDecoder(尾部残字节留存到下次);
     * 已是字符串则原样返回(上游已解码,无从修复);其他类型尽力转 Buffer,失败兜底 String()。
     * @param {Buffer|string|any} chunk
     * @returns {string}
     */
    write(chunk) {
      if (chunk == null) return '';
      if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
      if (typeof chunk === 'string') return chunk;
      try {
        return decoder.write(Buffer.from(chunk));
      } catch {
        return String(chunk);
      }
    },
    /**
     * 冲刷解码器内残留的字节(流结束时)。若上游在多字节序列中途截断,
     * 这里返回的仍是 U+FFFD——那是真正的上游截断,已无字节可拼。
     * @returns {string}
     */
    end() {
      return decoder.end();
    },
  };
}

module.exports = { createSseTextDecoder };
