-- 创建 user_logs 表（如果不存在）
-- 用于记录用户操作日志

CREATE TABLE IF NOT EXISTS user_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    username VARCHAR(50),
    action VARCHAR(50) NOT NULL,
    action_description TEXT,
    ip_address VARCHAR(50),
    user_agent TEXT,
    session_id VARCHAR(100),
    status VARCHAR(20) DEFAULT 'success',
    details JSONB DEFAULT '{}',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引以提高查询性能
CREATE INDEX IF NOT EXISTS idx_user_logs_user_id ON user_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_user_logs_action ON user_logs(action);
CREATE INDEX IF NOT EXISTS idx_user_logs_timestamp ON user_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_user_logs_status ON user_logs(status);

-- 添加注释
COMMENT ON TABLE user_logs IS '用户操作日志表';
COMMENT ON COLUMN user_logs.user_id IS '用户ID';
COMMENT ON COLUMN user_logs.username IS '用户名';
COMMENT ON COLUMN user_logs.action IS '操作类型（login, logout, register等）';
COMMENT ON COLUMN user_logs.action_description IS '操作描述';
COMMENT ON COLUMN user_logs.ip_address IS 'IP地址';
COMMENT ON COLUMN user_logs.user_agent IS '用户代理（浏览器信息）';
COMMENT ON COLUMN user_logs.session_id IS '会话ID';
COMMENT ON COLUMN user_logs.status IS '状态（success, failed, warning）';
COMMENT ON COLUMN user_logs.details IS '详细信息（JSON格式）';
COMMENT ON COLUMN user_logs.timestamp IS '操作时间';
