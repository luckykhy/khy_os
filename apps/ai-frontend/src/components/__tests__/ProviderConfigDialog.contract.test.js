/**
 * ProviderConfigDialog — 源级契约测试（node 环境不挂载组件，readFileSync + 正则断言）。
 *
 * 锁「新增/编辑供应商/密钥」向导对话框的接线不变式：
 * 打开即重置（不泄漏旧状态）、密钥永不明文预填、dry-run 测试的
 * 前置校验与三态结果（ok/empty/fail）、submit payload 的归一化规则、
 * 接口格式枚举与后端的对齐（openai/anthropic/openai_responses/gemini）。
 * 文件路径：src/components/gateway/ProviderConfigDialog.vue
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'gateway', 'ProviderConfigDialog.vue'), 'utf-8');

test('dialog 打开（@open）触发 syncFromProps 全量重置，防旧状态泄漏', () => {
  expect(SRC).toContain('@open="syncFromProps"');
  expect(SRC).toMatch(/function syncFromProps\(\) \{[\s\S]*?presetId\.value = '';[\s\S]*?testState\.value = '';[\s\S]*?discovered\.value = \[\];/);
});

test('edit 模式密钥绝不明文预填（留空 = 保存时不改）；其它字段来自 entry', () => {
  expect(SRC).toMatch(/if \(props\.mode === 'edit' && props\.entry\) \{[\s\S]*?form\.key = '';[\s\S]*?form\.baseUrl = props\.entry\.baseUrl \|\| '';/);
  // UI 提示：留空表示不修改现有 Key
  expect(SRC).toContain("'留空表示不修改现有 Key'");
});

test('接口格式枚举与后端 userGatewayConfigService 对齐（4 种，单一真源）', () => {
  expect(SRC).toMatch(/value: 'openai'[^;]*OpenAI 兼容/);
  expect(SRC).toMatch(/value: 'anthropic'[^;]*Anthropic Messages/);
  expect(SRC).toMatch(/value: 'openai_responses'[^;]*OpenAI Responses/);
  expect(SRC).toMatch(/value: 'gemini'[^;]*Google Gemini/);
});

test('测试连接（dry-run）前置校验：先要有 key，再要有 baseUrl/endpoint', () => {
  expect(SRC).toMatch(/if \(typeof props\.tester !== 'function'\) return;/);
  expect(SRC).toMatch(/if \(!apiKey\) \{[\s\S]*?'测试连接需要填入 API Key（留空仅用于保存时不修改）'[\s\S]*?'请先填写 API Key'[\s\S]*?\}/);
  expect(SRC).toMatch(/if \(!form\.baseUrl\.trim\(\) && !form\.endpoint\.trim\(\)\) \{[\s\S]*?return showWarning\('请填写 Base URL 后再测试'\);/);
});

test('tester 调用传结构化 payload：apiFormat 空值收敛为 undefined（不发空串）', () => {
  expect(SRC).toMatch(/await props\.tester\(\{[\s\S]*?baseUrl: form\.baseUrl\.trim\(\),[\s\S]*?apiKey,[\s\S]*?apiFormat: form\.apiFormat\.trim\(\) \|\| undefined,[\s\S]*?\}\)/);
});

test('测试结果三态：ok（有模型）/ empty（连接通但无模型列表）/ fail（带原因文案）', () => {
  expect(SRC).toMatch(/if \(res\?\.ok\) \{[\s\S]*?testState\.value = list\.length \? 'ok' : 'empty';[\s\S]*?\} else \{[\s\S]*?testState\.value = 'fail';[\s\S]*?testError\.value = res\?\.error \|\| '测试失败';/);
  // 异常路径：HTTP 错误优先取 response.data.message
  expect(SRC).toContain("err?.response?.data?.message || err?.message || '测试失败'");
  // 模板三态各有独立 UI 提示（成功/无模型/失败）
  expect(SRC).toContain("testState === 'ok'");
  expect(SRC).toContain("testState === 'empty'");
  expect(SRC).toContain("testState === 'fail'");
});

test('发现模型可单个导入或全部导入，且去重（已在列表的不再 push）', () => {
  expect(SRC).toMatch(/function importOneDiscovered\(id\) \{[\s\S]*?if \(!form\.models\.includes\(id\)\) form\.models\.push\(id\);/);
  expect(SRC).toMatch(/function importAllDiscovered\(\) \{[\s\S]*?if \(d && d\.id && !form\.models\.includes\(d\.id\)\) form\.models\.push\(d\.id\);/);
});

test('initialModels 归一化：行对象取 model/id、裸字符串直接取，trim + 去重', () => {
  expect(SRC).toMatch(/const id = String\(\(m && \(m\.model \?\? m\.id\)\) \?\? m \?\? ''\)\.trim\(\);/);
});

test('submit payload：provider 小写归一、add 模式强制 key、models trim 去空', () => {
  expect(SRC).toMatch(/const provider = form\.provider\.trim\(\)\.toLowerCase\(\);/);
  expect(SRC).toMatch(/if \(!provider\) return showWarning\('请填写 Provider'\);/);
  expect(SRC).toMatch(/if \(props\.mode === 'add' && !form\.key\.trim\(\)\) return showWarning\('请填写 API Key'\);/);
  expect(SRC).toContain("models: form.models.map((m) => String(m).trim()).filter(Boolean),");
  // payload 携带 mode + entry id，父组件据此 diff（add → create+seed；edit → update）
  expect(SRC).toMatch(/emit\('submit', \{[\s\S]*?mode: props\.mode,[\s\S]*?id: props\.entry\?\.id \?\? null,/);
});

test('emits 只有两个：update:visible（v-model）与 submit（父组件持有写操作）', () => {
  expect(SRC).toMatch(/defineEmits\(\['update:visible', 'submit'\]\)/);
  // 组件自身不直接调 request（写操作全部上浮给父级 orchestrator）
  expect(SRC).not.toContain('request.');
});

test('标题随模式切换：edit → 编辑，add → 新增', () => {
  expect(SRC).toContain("mode === 'edit' ? '编辑供应商 / 密钥' : '新增供应商 / 密钥'");
  expect(SRC).toContain("mode === 'edit' ? '保存修改' : '创建'");
});
