'use strict';

/**
 * deepClone.js — 深拷贝工具函数
 *
 * 替代 JSON.parse(JSON.stringify(...)) 性能反模式
 * 支持循环引用、Date、RegExp、Map、Set 等类型
 *
 * @param {*} obj 要克隆的对象
 * @returns {*} 克隆后的对象
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }
  
  if (obj instanceof RegExp) {
    return new RegExp(obj.source, obj.flags);
  }
  
  if (obj instanceof Map) {
    const map = new Map();
    for (const [key, value] of obj) {
      map.set(deepClone(key), deepClone(value));
    }
    return map;
  }
  
  if (obj instanceof Set) {
    const set = new Set();
    for (const value of obj) {
      set.add(deepClone(value));
    }
    return set;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item));
  }
  
  const cloned = {};
  for (const key of Object.keys(obj)) {
    cloned[key] = deepClone(obj[key]);
  }
  return cloned;
}

module.exports = { deepClone };
