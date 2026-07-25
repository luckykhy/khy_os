-- 创建标的列表表
CREATE TABLE IF NOT EXISTS instruments (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL, -- 'index', 'stock', 'etf', 'bond', 'futures'
  market VARCHAR(20), -- 'SSE', 'SZSE', 'CFFEX', etc.
  category VARCHAR(50), -- '指数', 'A股', 'ETF', '债券'
  listing_date DATE, -- 上市日期
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'suspended', 'delisted'
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_instruments_symbol ON instruments(symbol);
CREATE INDEX IF NOT EXISTS idx_instruments_type ON instruments(type);
CREATE INDEX IF NOT EXISTS idx_instruments_category ON instruments(category);
CREATE INDEX IF NOT EXISTS idx_instruments_status ON instruments(status);

-- 添加注释
COMMENT ON TABLE instruments IS '金融标的列表';
COMMENT ON COLUMN instruments.symbol IS '标的代码 (如: sh000001, sz399001)';
COMMENT ON COLUMN instruments.name IS '标的名称 (如: 上证指数)';
COMMENT ON COLUMN instruments.type IS '标的类型 (index/stock/etf/bond/futures)';
COMMENT ON COLUMN instruments.market IS '交易市场 (SSE/SZSE/CFFEX等)';
COMMENT ON COLUMN instruments.category IS '分类 (指数/A股/ETF/债券)';
COMMENT ON COLUMN instruments.listing_date IS '上市日期';
COMMENT ON COLUMN instruments.status IS '状态 (active/suspended/delisted)';
