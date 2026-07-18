'use strict';

/**
 * LRUCache — minimal Least-Recently-Used cache based on Map insertion order.
 *
 * On get: delete + re-set moves the entry to most-recent position.
 * On set: evicts the least-recent entry (Map's first key) when capacity exceeded.
 */

class LRUCache {
  constructor(maxSize) {
    this._max = maxSize;
    this._map = new Map();
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const val = this._map.get(key);
    this._map.delete(key);
    this._map.set(key, val);
    return val;
  }

  has(key) {
    return this._map.has(key);
  }

  set(key, val) {
    if (this._map.has(key)) this._map.delete(key);
    this._map.set(key, val);
    if (this._map.size > this._max) {
      const firstKey = this._map.keys().next().value;
      this._map.delete(firstKey);
    }
  }

  delete(key) {
    return this._map.delete(key);
  }

  clear() {
    this._map.clear();
  }

  get size() {
    return this._map.size;
  }
}

module.exports = { LRUCache };
