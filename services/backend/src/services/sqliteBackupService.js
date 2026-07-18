/**
 * SQLite backup service for offline / portable mode
 * Provides read-only fallback when PostgreSQL is unavailable.
 */
const path = require('path');
const logger = require('../utils/logger');

const DB_PATH = path.join(__dirname, '../../data/backup.sqlite');

class SqliteBackupService {
  constructor() {
    this.db = null;
    this.available = false;
  }

  init() {
    try {
      const Database = require('better-sqlite3');
      this.db = new Database(DB_PATH);
      this.db.pragma('journal_mode = WAL');

      // Create kline backup table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS kline_backup (
          symbol TEXT NOT NULL,
          period TEXT NOT NULL DEFAULT 'daily',
          trade_date TEXT NOT NULL,
          open_price REAL,
          high_price REAL,
          low_price REAL,
          close_price REAL,
          volume INTEGER,
          amount REAL,
          PRIMARY KEY (symbol, period, trade_date)
        )
      `);

      this.available = true;
      logger.info('SQLite backup service initialized', { path: DB_PATH });
    } catch (err) {
      logger.warn('SQLite backup unavailable (better-sqlite3 may not be installed)', { error: err.message });
      this.available = false;
    }
  }

  /**
   * Bulk insert kline data into SQLite
   */
  backupKlineData(symbol, period, rows) {
    if (!this.available || !rows?.length) return 0;

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO kline_backup
        (symbol, period, trade_date, open_price, high_price, low_price, close_price, volume, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((data) => {
      let count = 0;
      for (const r of data) {
        insert.run(symbol, period, r.date || r.trade_date, r.open, r.high, r.low, r.close, r.volume, r.amount || 0);
        count++;
      }
      return count;
    });

    return tx(rows);
  }

  /**
   * Query kline data from SQLite backup
   */
  getKlineData(symbol, period, startDate, endDate, limit = 1000) {
    if (!this.available) return [];

    let sql = 'SELECT * FROM kline_backup WHERE symbol = ? AND period = ?';
    const params = [symbol, period];

    if (startDate) { sql += ' AND trade_date >= ?'; params.push(startDate); }
    if (endDate) { sql += ' AND trade_date <= ?'; params.push(endDate); }
    sql += ' ORDER BY trade_date ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(r => ({
      date: r.trade_date,
      open: r.open_price,
      high: r.high_price,
      low: r.low_price,
      close: r.close_price,
      volume: r.volume,
      amount: r.amount
    }));
  }

  isAvailable() {
    return this.available;
  }
}

module.exports = new SqliteBackupService();
