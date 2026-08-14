// 优先使用 backend 的 auth middleware（含 session 管理），回退到 shared 版本
// 确保 khyquant 路由通过统一认证，支持 JWT + session  revocation
const backendAuth = require('../../../services/backend/src/middleware/auth');
module.exports = backendAuth;
