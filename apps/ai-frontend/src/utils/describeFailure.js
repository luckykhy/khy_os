// Map a rejected API promise to a user-facing message.
//
// Every message follows the repo's error contract (AGENTS.md 规则 2.2):
// {问题一句话}：{识别码}，{具体修复动作}. The two halves matter differently —
// the status/code is what a support person can search for, the fix action is
// what the user can actually do next. A generic "请求失败，请重试" fails both.
//
// Kept pure on purpose: it is the single place where HTTP status becomes a
// Chinese sentence, so the mapping is unit-testable without a browser and two
// views cannot drift into telling the user different things about the same
// 403.
const NETWORK_PATTERN = /网络连接异常|ECONN|ETIMEDOUT|timeout/i;

export function describeFailure(err, fallback) {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const serverMsg = String(body?.message || body?.error || '').trim();
  const code = String(body?.code || '').trim();
  const cause = code ? `（${code}）` : '';

  if (status === 429) {
    return '限流 (429)：同一 IP 15 分钟内最多 10 次，请 15 分钟后再试';
  }
  if (status === 403) {
    return `账户不可用 (403)${cause}：账号可能已被禁用，请联系管理员处理`;
  }
  if (status === 401) {
    return '认证失败 (401)：当前密码错误或会话已失效，请重新登录后重试';
  }
  if (status === 404) {
    return '资源不存在 (404)：请确认操作的对象仍然有效，或刷新页面后重试';
  }
  if (status === 400) {
    return `${serverMsg || '输入不合法'} (400)：${fallback || '请核对填写内容后重试'}`;
  }
  if (status >= 500) {
    return `上游异常 (${status})：后端服务暂不可用，请稍后重试或运行 khy doctor`;
  }

  // Any other client-side failure still carries its status code, so the answer
  // keeps the {问题}：{识别码}，{修复} shape even for a status nobody mapped
  // yet (409 conflict, 422 validation, ...). Without this the message degraded
  // to the bare fallback, which drops the identifier a support person needs.
  if (status && status >= 400) {
    return `${serverMsg || '请求失败'} (${status})：${fallback || '请稍后重试'}`;
  }

  const local = String(err?.message || '');
  if (NETWORK_PATTERN.test(local)) {
    return '网络连接失败：请检查网络代理设置，或确认后端已启动';
  }

  return serverMsg || fallback || '操作失败：请重试，或运行 khy doctor 检查后端';
}

export default describeFailure;
