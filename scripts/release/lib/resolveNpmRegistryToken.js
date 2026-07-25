'use strict';
/**
 * 纯叶子 resolveNpmRegistryToken —— 从 npmrc 文本解析出指定 registry 的
 * `_authToken` 真值。零 IO:只吃字符串、吐字符串/null,不读文件、不读环境、不写
 * 标准流、不 process.exit。真正读 ~/.npmrc 的副作用留在调用方(publish-dual.sh
 * preflight 里的内联 `node -e` 薄壳)。
 *
 * 动机(消除 npm 发布 404 + 双渠道裂脑):
 *   publish-dual.sh 从 packaging/npm/ 目录发布时,committed `.npmrc` 里
 *     //registry.npmjs.org/:_authToken=${NPM_TOKEN}
 *   会在 NPM_TOKEN 未设时展开为**空 token**,并 SHADOW(遮蔽)用户全局 ~/.npmrc
 *   的真 token → `npm publish` 报 404(no scope permission),而先跑的 `npm whoami`
 *   (读 ~/.npmrc)却通过,给出虚假信心。pip 已先发成功、npm 卡旧版 → 破双渠道版本
 *   同步红线。修法:发布前用本叶子从 ~/.npmrc 派生 NPM_TOKEN 回填,让 committed
 *   `.npmrc` 的 ${NPM_TOKEN} 解析出真 token;派生仍失败则在**任何上传之前**中止。
 *
 * 安全:本叶子只解析、绝不打印 token;调用方只回填进环境变量、不落盘、不 echo 明文。
 */

// 从 registry URL 取 npm `//host/` key 里的主机部分:去协议、去路径,保留可能的端口。
function _registryHost(registryUrl) {
  const raw = String(registryUrl == null ? '' : registryUrl).trim();
  if (!raw) return '';
  const noProto = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  return noProto.replace(/\/.*$/, ''); // 去掉主机后的路径
}

// 未解析的 `${VAR}` / `$VAR` 占位或空白 —— 这类不是真 token,必须拒绝(否则会把
// 占位符本身当 token 传下去,正是 404 的根因)。
function _isPlaceholderOrEmpty(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return true;
  if (/^\$\{[^}]*\}$/.test(v)) return true; // ${NPM_TOKEN}
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return true; // $NPM_TOKEN
  return false;
}

// 去掉一层成对引号包裹(npmrc 里 token 通常不带引号,但容忍之)。
function _stripQuotes(value) {
  const v = String(value == null ? '' : value);
  if (v.length >= 2) {
    const a = v[0];
    const b = v[v.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return v.slice(1, -1);
  }
  return v;
}

/**
 * resolveNpmRegistryToken(npmrcContent, registryUrl) -> string | null
 *
 * 扫描 npmrc 文本,返回**第一个**匹配 registry 主机、且非占位/非空的
 * `_authToken` 值;无命中则返回 null。主机比较对端口宽松(带/不带 :port 均可)。
 * 跳过空行与注释行(# 或 ;)。
 */
function resolveNpmRegistryToken(npmrcContent, registryUrl) {
  const host = _registryHost(registryUrl || 'https://registry.npmjs.org/');
  if (!host) return null;
  const hostNoPort = host.replace(/:\d+$/, '');

  const lines = String(npmrcContent == null ? '' : npmrcContent).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    // 形如 `//<host>/:_authToken=VALUE`(host 可含端口)。
    const m = trimmed.match(/^\/\/([^/]+)\/:_authToken=(.*)$/);
    if (!m) continue;

    const lineHost = m[1];
    if (lineHost !== host && lineHost.replace(/:\d+$/, '') !== hostNoPort) continue;

    const value = _stripQuotes(m[2].trim()).trim();
    if (_isPlaceholderOrEmpty(value)) continue;
    return value;
  }
  return null;
}

module.exports = {
  resolveNpmRegistryToken,
  _registryHost,
  _isPlaceholderOrEmpty,
  _stripQuotes,
};
