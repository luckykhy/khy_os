/**
 * CustomProviderCard — 源级契约测试（node 环境不挂载组件，readFileSync + 正则断言）。
 *
 * 本卡片是 CustomProviderForm 纯逻辑（customProviderForm.js，已有真单测）的薄视图。
 * 这里锁「接线不变式」：校验委托给纯 helper（组件不自造规则）、emit 事件集合、
 * preset 自动填充覆盖的字段、密钥字段的安全属性、按供应商分组 + 模型分支
 * 的派生逻辑、危险操作（删组/删模型）的确认框。
 * 文件路径：src/components/gateway/CustomProviderCard.vue
 */
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'gateway', 'CustomProviderCard.vue'), 'utf-8');

test('添加提交委托给受测纯 helper（组件不自造校验/payload 规则）', () => {
  expect(SRC).toContain("import { validateProviderDraft, buildProviderPayload } from './customProviderForm.js'");
  // onAdd：先校验（错误走 showWarning），通过后 emit('add', payload)，随后全字段清空
  expect(SRC).toMatch(/const err = validateProviderDraft\(draft\);\s*if \(err\) return showWarning\(err\);/);
  expect(SRC).toContain("emit('add', buildProviderPayload(draft))");
  expect(SRC).toMatch(/draft\.provider = '';/);
  expect(SRC).toMatch(/presetId\.value = '';/);
});

test('emits 集合固定：7 个事件（新增/加模型/换钥/删条目/删组/删模型/开向导）', () => {
  expect(SRC).toMatch(/defineEmits\(\[\s*'add',\s*'add-model',\s*'remove-entry',\s*'remove-provider',\s*'replace-entry',\s*'remove-model',\s*'open-config',\s*\]\)/);
});

test('props：scope/providers/models/busy/presets，scope 缺省 "user"', () => {
  expect(SRC).toMatch(/scope: \{ type: String, default: 'user' \}/);
  expect(SRC).toMatch(/providers: \{ type: Array, default: \(\) => \[\] \}/);
  expect(SRC).toMatch(/presets: \{ type: Array, default: \(\) => \[\] \}/);
});

test('scope 决定标题/描述：user → 「我的自定义 Provider 密钥池」，global → 全局池', () => {
  expect(SRC).toMatch(/const isUser = computed\(\(\) => props\.scope !== 'global'\)/);
  expect(SRC).toContain("'我的自定义 Provider 密钥池'");
  expect(SRC).toContain("'全局自定义 Provider 密钥池'");
});

test('API Key 输入为 password + show-password + autocomplete="new-password"（不回填密钥）', () => {
  // 新增表单
  expect(SRC).toMatch(/el-input\s+v-model="draft\.key"[\s\S]{0,120}type="password"[\s\S]{0,120}show-password[\s\S]{0,200}autocomplete="new-password"/);
  // 内联替换框同样规格
  expect(SRC).toMatch(/el-input\s+ref="editInputRef"[\s\S]{0,200}type="password"[\s\S]{0,200}autocomplete="new-password"/);
});

test('preset 选择只填表单、不改语义：provider/displayName/baseUrl/apiFormat/endpoint 五个字段', () => {
  expect(SRC).toMatch(/function onPickPreset\(id\) \{[\s\S]*?draft\.provider = p\.id;[\s\S]*?if \(!draft\.displayName\) draft\.displayName = p\.label \|\| '';[\s\S]*?draft\.baseUrl = p\.baseUrl \|\| '';[\s\S]*?draft\.apiFormat = p\.apiFormat \|\| '';[\s\S]*?draft\.endpoint = p\.baseUrl \|\| '';[\s\S]*?\}/);
  // keyPlaceholder 只展示预设示例（示例文本，绝不塞真密钥）
  expect(SRC).toMatch(/return p && p\.keyExample \? p\.keyExample : 'sk-\.\.\.';/);
});

test('分组 computed：同 provider 聚合（首个非空 displayName 作为组别名），条目按出现序', () => {
  expect(SRC).toContain('if (!map.has(p.provider)) {');
  expect(SRC).toContain('if (!g.displayName && p.displayName) g.displayName = p.displayName;');
  expect(SRC).toContain('g.entries.push(p);');
  expect(SRC).toContain('return Array.from(map.values());');
});

test('模型分支索引：provider 大小写不敏感（toLowerCase），keys 共享同一模型列表', () => {
  expect(SRC).toContain('const key = String(m.provider).toLowerCase();');
  expect(SRC).toContain("return modelsByProvider.value.get(String(provider || '').toLowerCase()) || [];");
  // 停用模型划线显示
  expect(SRC).toMatch(/:class="\{ 'is-off': m\.isActive === false \}"/);
});

test('删整组/删模型走 ElMessageBox.confirm 确认（取消静默吞掉）', () => {
  expect(SRC).toMatch(/await ElMessageBox\.confirm\(`确认删除 provider「\$\{provider\}」的全部密钥吗？`, '删除整组', \{[\s\S]*?type: 'warning',[\s\S]*?\}\)/);
  expect(SRC).toMatch(/await ElMessageBox\.confirm\(`确认删除模型「\$\{m\.model\}」吗？`, '删除模型', \{ type: 'warning' \}\)/);
  // 取消（reject）路径被 catch 吞掉，不冒泡
  expect(SRC).toMatch(/}\s*catch\s*\{\s*\/\* cancelled \*\/\s*\}/);
});

test('内联换钥：确认需非空白（trim），emit replace-entry { id, key } 后复位编辑态', () => {
  expect(SRC).toMatch(/const key = editValue\.value\.trim\(\);\s*if \(!key\) return showWarning\('请输入新的 API Key'\);/);
  expect(SRC).toContain("emit('replace-entry', { id: entry.id, key });");
  expect(SRC).toContain('onCancelReplace();');
  // 确认按钮在空白输入时禁用
  expect(SRC).toMatch(/:disabled="!editValue\.trim\(\)"/);
});

test('向导入口：「新增」开 add 模式空 entry；「编辑 / 测试」预填组首条 entry', () => {
  expect(SRC).toContain("emit('open-config', { mode: 'add', provider: '', entry: null });");
  expect(SRC).toMatch(/const entry = \(g\.entries && g\.entries\[0\]\) \|\| null;\s*emit\('open-config', \{ mode: 'edit', provider: g\.provider, entry \}\);/);
});

test('删除单模型需有 id（不可定位的行不给删除按钮），emit remove-model 传 row id', () => {
  expect(SRC).toMatch(/if \(!m \|\| m\.id == null\) return;/);
  expect(SRC).toContain("emit('remove-model', m.id);");
  expect(SRC).toMatch(/v-if="m\.id != null"/);
});
