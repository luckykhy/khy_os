-- 添加平仓相关字段到 trades 表
-- 执行时间: 2026-02-20

-- 添加 is_closed 字段
ALTER TABLE trades ADD COLUMN IF NOT EXISTS is_closed BOOLEAN DEFAULT FALSE;
COMMENT ON COLUMN trades.is_closed IS '是否已平仓';

-- 添加 closed_at 字段
ALTER TABLE trades ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;
COMMENT ON COLUMN trades.closed_at IS '平仓时间';

-- 添加 closed_quantity 字段
ALTER TABLE trades ADD COLUMN IF NOT EXISTS closed_quantity DECIMAL(15, 4);
COMMENT ON COLUMN trades.closed_quantity IS '平仓数量';

-- 添加 related_trade_id 字段
ALTER TABLE trades ADD COLUMN IF NOT EXISTS related_trade_id INTEGER;
COMMENT ON COLUMN trades.related_trade_id IS '关联交易ID（用于部分平仓）';

-- 添加 profit 字段
ALTER TABLE trades ADD COLUMN IF NOT EXISTS profit DECIMAL(15, 2);
COMMENT ON COLUMN trades.profit IS '实际盈亏（平仓后）';

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_trades_is_closed ON trades(is_closed);
CREATE INDEX IF NOT EXISTS idx_trades_related_trade_id ON trades(related_trade_id);

-- 显示结果
SELECT 'Migration completed: add-close-fields-to-trades' AS status;
