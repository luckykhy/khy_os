'use strict';

/**
 * searchTokenizer.js — 领域中性的 CJK/ASCII 检索分词器（纯函数叶子模块）。
 *
 * 为什么单独成模块：量化知识库教学服务与 /learn 课程检索此前共用同一套分词逻辑——
 * 前者定义并导出 tokenizeForSearch，后者依赖前者借用它。这条「低层检索 → 高层教学
 * 服务」的依赖把 learningRetrieval / guideRetriever / guideInjector 三个模块拽进了
 * 巨型 SCC（循环依赖强连通分量）。
 *
 * 分词逻辑本是零依赖、零状态、领域无关的纯函数，没有任何理由依附在教学服务上。
 * 把它下沉为叶子模块，两侧共同依赖叶子（依赖倒置），即解开那条绑定边——
 * SCC 因此从 82 缩到 79（learningRetrieval + 其 trajectoryGuide 调用链脱离）。
 * 行为逐字保持不变：本文件即原教学服务内联分词实现的原样下沉。
 *
 * 注意：本仓库架构债扫描器按行匹配 require 调用语法、不剔除注释，故本文件**刻意**
 * 不在注释里书写 require 调用样式，以免凭空生成一条回指教学服务的幽灵依赖边
 * （那会把本叶子重新拖入 SCC、令解耦前功尽弃）。
 *
 * 设计纪律：纯函数、无 I/O、无模块状态、绝不抛（输入兜底为字符串）。
 */

/**
 * 把文本切成可检索的词项：中文按「单字 + 相邻 bigram」、英文/数字按整词。
 * 大小写归一、去重、滤空。领域无关——同义词扩展由各调用方自带的同义词表负责。
 *
 * @param {string} text 原始文本（任意类型经 String() 兜底）
 * @returns {string[]} 去重后的词项列表
 */
function tokenizeForSearch(text) {
  const lower = String(text || '').toLowerCase();
  const parts = lower.match(/[一-鿿]+|[a-z0-9_]+/g) || [];
  const tokens = [];
  for (const part of parts) {
    if (/^[一-鿿]+$/.test(part)) {
      for (let i = 0; i < part.length; i++) {
        tokens.push(part[i]);
        if (i < part.length - 1) tokens.push(part.slice(i, i + 2));
      }
    } else {
      tokens.push(part);
    }
  }
  return [...new Set(tokens.filter(Boolean))];
}

module.exports = { tokenizeForSearch };
