-- 为 users 表添加密保问题字段
-- 执行时间：2026-02-10

-- 添加密保问题字段
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS security_question VARCHAR(200),
ADD COLUMN IF NOT EXISTS security_answer VARCHAR(255);

-- 添加注释
COMMENT ON COLUMN users.security_question IS '密保问题';
COMMENT ON COLUMN users.security_answer IS '密保答案（加密）';

-- 查看表结构
\d users;
