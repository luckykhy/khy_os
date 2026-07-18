/**
 * sqlite3 兼容层（基于 better-sqlite3）。
 *
 * 目标：
 * - 在缺少 sqlite3 原生包时，为 Sequelize(v6) 提供最小可用的 sqlite API。
 * - 支持 sequelize sqlite dialect 依赖的 Database/run/all/get/close/serialize 接口。
 * @pattern Adapter, Flyweight
 */

const BetterSqlite3 = require('better-sqlite3');

const OPEN_READWRITE = 0x00000002;
const OPEN_CREATE = 0x00000004;

function normalizeArgs(params, callback) {
  if (typeof params === 'function') {
    return { params: [], callback: params };
  }
  return { params: params ?? [], callback };
}

function adaptParams(params) {
  if (Array.isArray(params)) return params.map(normalizeSqliteValue);
  if (!params || typeof params !== 'object') return params;

  const out = {};
  for (const [key, value] of Object.entries(params)) {
    const normalizedValue = normalizeSqliteValue(value);
    out[key] = normalizedValue;
    if (/^[$:@]/.test(key)) {
      out[key.slice(1)] = normalizedValue;
    }
  }
  return out;
}

function normalizeSqliteValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function isNoResultSetError(error) {
  return !!(
    error
    && typeof error.message === 'string'
    && error.message.includes('does not return data')
  );
}

class Database {
  constructor(filename, mode, callback) {
    this.filename = filename;
    this.uuid = undefined;

    try {
      this._db = new BetterSqlite3(filename, {
        fileMustExist: false,
        timeout: 5000
      });
      if (typeof callback === 'function') {
        process.nextTick(() => callback(null));
      }
    } catch (error) {
      if (typeof callback === 'function') {
        process.nextTick(() => callback(error));
      } else {
        throw error;
      }
    }
  }

  serialize(fn) {
    if (typeof fn === 'function') fn();
    return this;
  }

  parallelize(fn) {
    if (typeof fn === 'function') fn();
    return this;
  }

  run(sql, params, callback) {
    const normalized = normalizeArgs(params, callback);
    try {
      const stmt = this._db.prepare(sql);
      const adaptedParams = adaptParams(normalized.params);
      const info = Array.isArray(adaptedParams) || typeof adaptedParams === 'object'
        ? stmt.run(adaptedParams)
        : stmt.run();
      const meta = {
        lastID: Number(info.lastInsertRowid || 0),
        changes: Number(info.changes || 0)
      };
      if (typeof normalized.callback === 'function') {
        process.nextTick(() => normalized.callback.call(meta, null));
      }
    } catch (error) {
      if (typeof normalized.callback === 'function') {
        process.nextTick(() => normalized.callback(error));
      } else {
        throw error;
      }
    }
    return this;
  }

  all(sql, params, callback) {
    const normalized = normalizeArgs(params, callback);
    try {
      const stmt = this._db.prepare(sql);
      let rows;
      const adaptedParams = adaptParams(normalized.params);
      if (Array.isArray(adaptedParams) || typeof adaptedParams === 'object') {
        rows = stmt.all(adaptedParams);
      } else {
        rows = stmt.all();
      }
      if (typeof normalized.callback === 'function') {
        process.nextTick(() => normalized.callback(null, rows));
      }
    } catch (error) {
      // sqlite3 的 all() 在无结果语句上通常不报错；
      // better-sqlite3 会抛错，这里降级到 run() 并返回空结果，兼容 Sequelize 预期。
      if (isNoResultSetError(error)) {
        try {
          const stmt = this._db.prepare(sql);
          const adaptedParams = adaptParams(normalized.params);
          if (Array.isArray(adaptedParams) || typeof adaptedParams === 'object') {
            stmt.run(adaptedParams);
          } else {
            stmt.run();
          }
          if (typeof normalized.callback === 'function') {
            process.nextTick(() => normalized.callback(null, []));
          }
          return this;
        } catch (runError) {
          if (typeof normalized.callback === 'function') {
            process.nextTick(() => normalized.callback(runError));
            return this;
          }
          throw runError;
        }
      }
      if (typeof normalized.callback === 'function') {
        process.nextTick(() => normalized.callback(error));
      } else {
        throw error;
      }
    }
    return this;
  }

  get(sql, params, callback) {
    const normalized = normalizeArgs(params, callback);
    try {
      const stmt = this._db.prepare(sql);
      let row;
      const adaptedParams = adaptParams(normalized.params);
      if (Array.isArray(adaptedParams) || typeof adaptedParams === 'object') {
        row = stmt.get(adaptedParams);
      } else {
        row = stmt.get();
      }
      if (typeof normalized.callback === 'function') {
        process.nextTick(() => normalized.callback(null, row));
      }
    } catch (error) {
      if (isNoResultSetError(error)) {
        try {
          const stmt = this._db.prepare(sql);
          const adaptedParams = adaptParams(normalized.params);
          if (Array.isArray(adaptedParams) || typeof adaptedParams === 'object') {
            stmt.run(adaptedParams);
          } else {
            stmt.run();
          }
          if (typeof normalized.callback === 'function') {
            process.nextTick(() => normalized.callback(null, undefined));
          }
          return this;
        } catch (runError) {
          if (typeof normalized.callback === 'function') {
            process.nextTick(() => normalized.callback(runError));
            return this;
          }
          throw runError;
        }
      }
      if (typeof normalized.callback === 'function') {
        process.nextTick(() => normalized.callback(error));
      } else {
        throw error;
      }
    }
    return this;
  }

  exec(sql, callback) {
    try {
      this._db.exec(sql);
      if (typeof callback === 'function') {
        process.nextTick(() => callback(null));
      }
    } catch (error) {
      if (typeof callback === 'function') {
        process.nextTick(() => callback(error));
      } else {
        throw error;
      }
    }
    return this;
  }

  close(callback) {
    try {
      this._db.close();
      if (typeof callback === 'function') {
        process.nextTick(() => callback(null));
      }
    } catch (error) {
      if (typeof callback === 'function') {
        process.nextTick(() => callback(error));
      } else {
        throw error;
      }
    }
  }
}

module.exports = {
  Database,
  OPEN_READWRITE,
  OPEN_CREATE,
  verbose() {
    return module.exports;
  }
};
