/*
 * sqlite-adapter.js - dual-driver SQLite adapter with a better-sqlite3 shaped sync API.
 *
 * Driver order:
 *   1) built-in node:sqlite (Node >= 22.5; no flag needed on Node 24+, zero native deps)
 *   2) fallback to better-sqlite3 (native instance returned as-is, full API)
 *   3) neither available -> throw with repair guidance
 *
 * Export shape matches better-sqlite3:
 *   const Database = require(".../sqlite-adapter");
 *   const db = new Database(path, { readonly, timeout });
 * Destructuring is also supported: const { Database } = require(".../sqlite-adapter");
 * Diagnostics: require(".../sqlite-adapter").__driverInfo // { type: "node:sqlite" | "better-sqlite3" }
 */

"use strict";

let NodeDatabaseSync = null;
let BetterSqlite3 = null;
let driverType = null;
const loadErrors = [];

try {
  const nodeSqlite = require("node:sqlite");
  if (nodeSqlite && typeof nodeSqlite.DatabaseSync === "function") {
    NodeDatabaseSync = nodeSqlite.DatabaseSync;
    driverType = "node:sqlite";
  } else {
    loadErrors.push("node:sqlite: module present but DatabaseSync missing");
  }
} catch (err) {
  loadErrors.push("node:sqlite: " + (err && err.message ? err.message : err));
}

if (!driverType) {
  try {
    BetterSqlite3 = require("better-sqlite3");
    driverType = "better-sqlite3";
  } catch (err) {
    loadErrors.push("better-sqlite3: " + (err && err.message ? err.message : err));
  }
}

if (!driverType) {
  throw new Error(
    "[sqlite-adapter] No usable SQLite driver.\n"
    + "Attempts:\n  - " + loadErrors.join("\n  - ") + "\n"
    + "How to fix:\n"
    + "  1. Preferred: run with Node.js >= 22.5 (24+ recommended); built-in node:sqlite needs no compilation.\n"
    + "  2. Or: run `npm rebuild better-sqlite3` at the project root using the SAME Node version as runtime.\n"
    + "  3. Check that `node -p process.versions` matches the better-sqlite3 prebuilt binary ABI."
  );
}

// ---- value/param normalization (node:sqlite path only) ----

function normalizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** True when value is a plain object usable as a named-parameter bag. */
function isPlainBindObject(value) {
  if (value === null || typeof value !== "object") return false;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return false;
  if (value instanceof Date) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Normalize a named-parameter object.
 * mode = "keep"  -> keep caller keys as-is. node:sqlite allows bare named params by
 *                   default ({name} binds :name/$name/@name; {":name"} matches exactly),
 *                   so keeping keys works for both bare and prefixed callers.
 * mode = "strip" -> drop a leading :/$/@ (covers prefix-mismatch edge cases, e.g.
 *                   passing $name for :name). Passing BOTH key forms at once can
 *                   trigger duplicate/unknown-parameter errors in node:sqlite, so we
 *                   use keep-first-then-strip-retry instead of dual keys.
 */
function normalizeNamedParams(params, mode) {
  const out = {};
  for (const key of Object.keys(params)) {
    const normalized = normalizeValue(params[key]);
    if (mode === "strip" && /^[$:@]/.test(key)) out[key.slice(1)] = normalized;
    else out[key] = normalized;
  }
  return out;
}

/**
 * Classify bind args:
 *   run(a, b)        -> positional
 *   run([a, b])      -> positional (spread)
 *   run({ name: v }) -> named
 *   run([a], b)      -> positional (arrays flattened, better-sqlite3 style)
 */
function classifyBindArgs(args) {
  if (args.length === 1) {
    const only = args[0];
    if (Array.isArray(only)) return { named: null, positional: only.map(normalizeValue) };
    if (isPlainBindObject(only)) return { named: only, positional: null };
  }
  const flat = [];
  for (const arg of args) {
    if (Array.isArray(arg)) flat.push.apply(flat, arg);
    else flat.push(arg);
  }
  return { named: null, positional: flat.map(normalizeValue) };
}

function isNoResultSetError(error) {
  const msg = error && typeof error.message === "string" ? error.message : "";
  // better-sqlite3: "This statement does not return data. Use run() instead";
  // node:sqlite wording may differ, match loosely.
  return /does not return data|statement does not return|no data returned/i.test(msg);
}

function isNamedParamError(error) {
  const msg = error && typeof error.message === "string" ? error.message : "";
  return /named parameter|no parameter named|unknown parameter|missing named/i.test(msg);
}

// ---- StatementAdapter: wraps node:sqlite StatementSync ----

class StatementAdapter {
  constructor(database, stmt) {
    this.database = database;
    this._stmt = stmt;
    // node:sqlite StatementSync exposes sourceSQL
    this.source = typeof stmt.sourceSQL === "string" ? stmt.sourceSQL : "";
  }

  /** better-sqlite3 reader flag: statement returns a result set (by SQL prefix). */
  get reader() {
    const sql = this.source || (typeof this._stmt.sourceSQL === "string" ? this._stmt.sourceSQL : "");
    return /^\s*(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)/i.test(sql);
  }

  _invoke(method, args) {
    const bind = classifyBindArgs(args);
    if (bind.named) {
      try {
        return this._stmt[method](normalizeNamedParams(bind.named, "keep"));
      } catch (err) {
        if (isNamedParamError(err)) return this._stmt[method](normalizeNamedParams(bind.named, "strip"));
        throw err;
      }
    }
    return this._stmt[method].apply(this._stmt, bind.positional);
  }

  run() {
    const info = this._invoke("run", Array.prototype.slice.call(arguments));
    const rowid = info && info.lastInsertRowid !== undefined ? info.lastInsertRowid : 0;
    return {
      changes: Number(info && info.changes !== undefined ? info.changes : 0),
      lastInsertRowid: typeof rowid === "bigint" ? Number(rowid) : rowid
    };
  }

  get() {
    const args = Array.prototype.slice.call(arguments);
    try {
      return this._invoke("get", args);
    } catch (err) {
      // degrade non-result statements to run(), aligning with sqlite3 semantics
      if (isNoResultSetError(err)) { this._invoke("run", args); return undefined; }
      throw err;
    }
  }

  all() {
    const args = Array.prototype.slice.call(arguments);
    try {
      return this._invoke("all", args);
    } catch (err) {
      if (isNoResultSetError(err)) { this._invoke("run", args); return []; }
      throw err;
    }
  }

  iterate() {
    const args = Array.prototype.slice.call(arguments);
    if (typeof this._stmt.iterate === "function") {
      const bind = classifyBindArgs(args);
      if (bind.named) {
        try {
          return this._stmt.iterate(normalizeNamedParams(bind.named, "keep"));
        } catch (err) {
          if (isNamedParamError(err)) return this._stmt.iterate(normalizeNamedParams(bind.named, "strip"));
          throw err;
        }
      }
      return this._stmt.iterate.apply(this._stmt, bind.positional);
    }
    // no native iterate: fall back to iterating the all() snapshot
    return this.all.apply(this, args)[Symbol.iterator]();
  }
}

// ---- DatabaseAdapter: wraps node:sqlite DatabaseSync ----

class DatabaseAdapter {
  constructor(filename, options) {
    const opts = options && typeof options === "object" ? options : {};
    const location = (filename === undefined || filename === null || filename === "") ? ":memory:" : filename;

    this._name = typeof location === "string" ? location : ":memory:";
    this._memory = this._name === ":memory:";
    this._isOpen = false;

    // map better-sqlite3 options -> node:sqlite; ignore fileMustExist/verbose etc.
    // (readOnly on a missing file fails naturally, close to fileMustExist behavior)
    const dbOptions = {
      open: true,
      readOnly: !!opts.readonly,
      timeout: typeof opts.timeout === "number" ? opts.timeout : 5000
    };

    try {
      this._db = new NodeDatabaseSync(location, dbOptions);
    } catch (err) {
      // older node:sqlite may not support the timeout option: retry without it
      if (/timeout/i.test(String(err && err.message))) {
        delete dbOptions.timeout;
        this._db = new NodeDatabaseSync(location, dbOptions);
      } else {
        throw err;
      }
    }
    this._isOpen = true;
  }

  get open() {
    if (this._db && typeof this._db.isOpen === "boolean") return this._db.isOpen;
    return this._isOpen;
  }

  get name() { return this._name; }

  get memory() { return this._memory; }

  get inTransaction() {
    if (this._db && typeof this._db.isTransaction === "boolean") return this._db.isTransaction;
    return false;
  }

  prepare(sql) {
    return new StatementAdapter(this, this._db.prepare(sql));
  }

  exec(sql) {
    this._db.exec(sql);
    return this;
  }

  close() {
    this._db.close();
    this._isOpen = false;
    return this;
  }

  /**
   * better-sqlite3 pragma() shim:
   *   pragma("journal_mode = WAL") -> write (exec, returns undefined)
   *   pragma("journal_mode")       -> read (returns [{ journal_mode: "wal" }] array shape)
   */
  pragma(pragmaString) {
    const text = String(pragmaString);
    if (text.indexOf("=") !== -1) {
      this._db.exec("PRAGMA " + text);
      return undefined;
    }
    try {
      return this._db.prepare("PRAGMA " + text).all();
    } catch (err) {
      // some pragmas (e.g. optimize) may refuse prepare in some builds: degrade to exec
      this._db.exec("PRAGMA " + text);
      return [];
    }
  }

  /**
   * better-sqlite3 transaction() shim: returns a callable running
   * BEGIN IMMEDIATE -> fn(...args) -> COMMIT, ROLLBACK + rethrow on error.
   */
  transaction(fn) {
    if (typeof fn !== "function") throw new TypeError("Expected first argument to be a function");
    const db = this;
    const wrapped = function transactionWrapper() {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn.apply(this, arguments);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch (rollbackErr) { /* connection already broken */ }
        throw err;
      }
    };
    // better-sqlite3 variants are equivalent in this shim
    wrapped.deferred = wrapped;
    wrapped.immediate = wrapped;
    wrapped.exclusive = wrapped;
    return wrapped;
  }

  serialize(fn) {
    if (typeof fn === "function") fn();
    return this;
  }

  parallelize(fn) {
    if (typeof fn === "function") fn();
    return this;
  }
}

// ---- exports: default newable class; .Database for destructuring; __driverInfo for diagnostics ----

const ExportedDatabase = driverType === "better-sqlite3" ? BetterSqlite3 : DatabaseAdapter;

module.exports = ExportedDatabase;
module.exports.Database = ExportedDatabase;
module.exports.__driverInfo = { type: driverType };
