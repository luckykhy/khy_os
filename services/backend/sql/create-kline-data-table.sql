-- 历史K线数据表
CREATE TABLE IF NOT EXISTS kline_data (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  name VARCHAR(100),
  period VARCHAR(10) NOT NULL,
  trade_date DATE NOT NULL,
  open_price DECIMAL(12, 4),
  high_price DECIMAL(12, 4),
  low_price DECIMAL(12, 4),
  close_price DECIMAL(12, 4),
  volume BIGINT,
  amount DECIMAL(20, 4),
  change_amount DECIMAL(12, 4),
  change_percent DECIMAL(8, 4),
  turnover_rate DECIMAL(8, 4),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(symbol, period, trade_date)
);

CREATE INDEX IF NOT EXISTS idx_kline_symbol ON kline_data(symbol);
CREATE INDEX IF NOT EXISTS idx_kline_date ON kline_data(trade_date);
CREATE INDEX IF NOT EXISTS idx_kline_symbol_period ON kline_data(symbol, period);
CREATE INDEX IF NOT EXISTS idx_kline_symbol_date ON kline_data(symbol, trade_date);
CREATE INDEX IF NOT EXISTS idx_kline_query ON kline_data(symbol, period, trade_date DESC);

COMMENT ON TABLE kline_data IS '历史K线数据表';
COMMENT ON COLUMN kline_data.symbol IS '标的代码';
COMMENT ON COLUMN kline_data.period IS '周期(daily/weekly/monthly/1min/5min等)';
COMMENT ON COLUMN kline_data.trade_date IS '交易日期';
COMMENT ON COLUMN kline_data.open_price IS '开盘价';
COMMENT ON COLUMN kline_data.close_price IS '收盘价';

-- 数据同步日志表
CREATE TABLE IF NOT EXISTS kline_sync_log (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  period VARCHAR(10) NOT NULL,
  start_date DATE,
  end_date DATE,
  record_count INTEGER,
  status VARCHAR(20),
  error_message TEXT,
  sync_duration INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_log_symbol ON kline_sync_log(symbol);
CREATE INDEX IF NOT EXISTS idx_sync_log_date ON kline_sync_log(created_at);

COMMENT ON TABLE kline_sync_log IS '数据同步日志表';

-- 在backtests表添加data_source字段
ALTER TABLE backtests ADD COLUMN IF NOT EXISTS data_source VARCHAR(50);
COMMENT ON COLUMN backtests.data_source IS '数据来源(AData真实数据/数据库缓存/模拟数据)';
