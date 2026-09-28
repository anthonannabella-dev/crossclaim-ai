-- 初始化数据库和扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Activepieces 数据库
CREATE DATABASE activepieces;
GRANT ALL PRIVILEGES ON DATABASE activepieces TO customs;
