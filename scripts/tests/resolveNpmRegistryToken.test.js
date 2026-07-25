'use strict';
/**
 * 纯叶子 resolveNpmRegistryToken 契约测试。覆盖:标准 authToken 抽取、${VAR}/$VAR
 * 占位与空值拒绝、注释/空行跳过、registry 主机匹配(含/去端口)、trailing slash 归一、
 * 引号剥离、多命中取第一个真值、空内容/空 registry 边界。
 *
 * 只测纯叶子——不读文件、不碰环境,因此确定性、快速、无副作用。对应的 IO(读 ~/.npmrc)
 * 由 publish-dual.sh 的内联 node -e 薄壳承担,不在本测试范围。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
  resolveNpmRegistryToken,
  _registryHost,
  _isPlaceholderOrEmpty,
  _stripQuotes,
} = require('../release/lib/resolveNpmRegistryToken');

const REG = 'https://registry.npmjs.org/';

test('抽取标准 //registry.npmjs.org/:_authToken 的真值', () => {
  const npmrc = '//registry.npmjs.org/:_authToken=npm_ABC123realtoken\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), 'npm_ABC123realtoken');
});

test('拒绝 ${NPM_TOKEN} 占位(未展开)—— 返回 null,正是 404 根因', () => {
  const npmrc = '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), null);
});

test('拒绝 $NPM_TOKEN 无花括号占位', () => {
  const npmrc = '//registry.npmjs.org/:_authToken=$NPM_TOKEN\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), null);
});

test('拒绝空 authToken', () => {
  const npmrc = '//registry.npmjs.org/:_authToken=\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), null);
});

test('跳过注释行(# 与 ;)', () => {
  const npmrc = [
    '# //registry.npmjs.org/:_authToken=commented_out',
    '; //registry.npmjs.org/:_authToken=also_commented',
    '//registry.npmjs.org/:_authToken=real_after_comments',
  ].join('\n');
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), 'real_after_comments');
});

test('host 不匹配 → null(不同 registry 的 token 不误用)', () => {
  const npmrc = '//npm.pkg.github.com/:_authToken=ghp_something\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), null);
});

test('registry URL 无 trailing slash 也能匹配', () => {
  const npmrc = '//registry.npmjs.org/:_authToken=tok_noslash\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, 'https://registry.npmjs.org'), 'tok_noslash');
});

test('registry 带端口:行含 :443 而 URL 不含,仍匹配(端口宽松)', () => {
  const npmrc = '//registry.npmjs.org:443/:_authToken=tok_withport\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), 'tok_withport');
});

test('剥离成对引号包裹', () => {
  const npmrc = '//registry.npmjs.org/:_authToken="quoted_token"\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), 'quoted_token');
});

test('多个真 token 命中时取第一个', () => {
  const npmrc = [
    '//registry.npmjs.org/:_authToken=first_token',
    '//registry.npmjs.org/:_authToken=second_token',
  ].join('\n');
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), 'first_token');
});

test('占位在前、真值在后 → 跳过占位取真值', () => {
  const npmrc = [
    '//registry.npmjs.org/:_authToken=${NPM_TOKEN}',
    '//registry.npmjs.org/:_authToken=real_fallback',
  ].join('\n');
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), 'real_fallback');
});

test('空内容 / null / undefined → null', () => {
  assert.strictEqual(resolveNpmRegistryToken('', REG), null);
  assert.strictEqual(resolveNpmRegistryToken(null, REG), null);
  assert.strictEqual(resolveNpmRegistryToken(undefined, REG), null);
});

test('registry 为空/undefined 时回退官方源(falsy → 官方默认)', () => {
  const npmrc = '//registry.npmjs.org/:_authToken=t';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, ''), 't');
  assert.strictEqual(resolveNpmRegistryToken(npmrc, undefined), 't');
});

test('CRLF 行尾也能解析', () => {
  const npmrc = 'registry=https://registry.npmjs.org/\r\n//registry.npmjs.org/:_authToken=crlf_token\r\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc, REG), 'crlf_token');
});

test('默认 registry 参数缺省时按官方源解析', () => {
  const npmrc = '//registry.npmjs.org/:_authToken=default_reg_token\n';
  assert.strictEqual(resolveNpmRegistryToken(npmrc), 'default_reg_token');
});

// —— 内部辅助的直接契约 ——
test('_registryHost:去协议去路径保端口', () => {
  assert.strictEqual(_registryHost('https://registry.npmjs.org/'), 'registry.npmjs.org');
  assert.strictEqual(_registryHost('https://registry.npmjs.org:443/foo'), 'registry.npmjs.org:443');
  assert.strictEqual(_registryHost(''), '');
});

test('_isPlaceholderOrEmpty:占位与空为真,真值为假', () => {
  assert.strictEqual(_isPlaceholderOrEmpty('${NPM_TOKEN}'), true);
  assert.strictEqual(_isPlaceholderOrEmpty('$NPM_TOKEN'), true);
  assert.strictEqual(_isPlaceholderOrEmpty('   '), true);
  assert.strictEqual(_isPlaceholderOrEmpty(''), true);
  assert.strictEqual(_isPlaceholderOrEmpty('npm_realtoken'), false);
});

test('_stripQuotes:仅剥成对引号', () => {
  assert.strictEqual(_stripQuotes('"x"'), 'x');
  assert.strictEqual(_stripQuotes("'x'"), 'x');
  assert.strictEqual(_stripQuotes('x'), 'x');
  assert.strictEqual(_stripQuotes('"x'), '"x');
});
