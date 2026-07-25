/**
 * Projects subsystem wiring assertions (frontend).
 *
 * The Projects (coding workspace) feature spans several single-source-of-truth
 * files: the viewLoaders chunk map, the router children, the sidebar menu, and
 * the two composables (useProjects + useChatConversations project linkage).
 * These files import Vue and the `@/` alias, so they can't be imported directly
 * under the plain Node test runner — instead we assert the wiring at the source
 * level, which is exactly what breaks silently if a future edit drops a link.
 *
 * Zero deps — run with the built-in Node test runner (apps/ai-frontend is
 * type:module):
 *   node --test src/composables/useProjects.wiring.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..'); // apps/ai-frontend/src

function read(rel) {
  return readFileSync(join(appRoot, rel), 'utf8');
}

test('viewLoaders registers the /projects chunk importer', () => {
  const src = read('composables/useRoutePrefetch.js');
  assert.match(src, /'\/projects':\s*\(\)\s*=>\s*import\('@\/views\/Projects\.vue'\)/,
    'useRoutePrefetch.viewLoaders must lazy-import Projects.vue at /projects');
});

test('router mounts the Projects route (auth-only, no requiresAdmin)', () => {
  const src = read('router/index.js');
  assert.match(src, /path:\s*'projects'/, 'router children must include a projects path');
  assert.match(src, /name:\s*'Projects'/, 'router must name the Projects route');
  assert.match(src, /viewLoaders\['\/projects'\]/, 'router must resolve the /projects viewLoader');
  // Guard against accidentally gating it behind admin: the projects route block
  // must not carry a requiresAdmin meta flag. Check the immediate route object region.
  const block = src.slice(src.indexOf("name: 'Projects'") - 200, src.indexOf("name: 'Projects'") + 120);
  assert.doesNotMatch(block, /requiresAdmin:\s*true/, 'Projects route must stay auth-only');
});

test('sidebar menu exposes the 项目工作区 entry with the Folder icon', () => {
  const src = read('views/Layout.vue');
  assert.match(src, /Folder\b/, 'Layout must import the Folder icon');
  assert.match(src, /path:\s*'\/projects'.*icon:\s*Folder/s,
    'USER_MENU must list /projects with the Folder icon');
});

test('useProjects assembles the per-user REST URLs and shares activeProjectId', () => {
  const src = read('composables/useProjects.js');
  // CRUD endpoints.
  assert.match(src, /'\/api\/ai\/projects'/, 'list GET endpoint base');
  assert.match(src, /includeArchived=1/, 'includeArchived toggle query');
  assert.match(src, /request\.post\('\/api\/ai\/projects',/, 'create POST endpoint');
  assert.match(src, /request\.put\(`\/api\/ai\/projects\/\$\{id\}`/, 'update PUT endpoint');
  assert.match(src, /request\.delete\(`\/api\/ai\/projects\/\$\{id\}`\)/, 'delete endpoint');
  assert.match(src, /request\.post\(`\/api\/ai\/projects\/\$\{id\}\/archive`/, 'archive endpoint');
  // Active-project selection is module-scoped (shared across instances) and
  // persisted to localStorage so the chat sidebar and the projects view agree.
  assert.match(src, /const activeProjectId = ref\(readActive\(\)\)/,
    'activeProjectId must be a module-level shared ref');
  assert.match(src, /localStorage\.setItem\(ACTIVE_KEY/, 'active project must persist to localStorage');
});

test('useChatConversations links conversations to a project (filter + stamp)', () => {
  const src = read('composables/useChatConversations.js');
  // fetchList appends ?projectId only for a positive id (default call unchanged).
  assert.match(src, /async function fetchList\(projectId = null\)/,
    'fetchList must accept an optional projectId');
  assert.match(src, /\/api\/ai\/conversations\?projectId=\$\{pid\}/,
    'fetchList must filter by projectId when positive');
  // createConversation stamps projectId only when positive.
  assert.match(src, /createConversation\(\{ messages, title, projectId \}/,
    'createConversation must accept projectId');
  assert.match(src, /body\.projectId = pid/, 'createConversation must stamp a positive projectId');
});

test('AIChat wires the project selector into the sidebar', () => {
  const src = read('views/AIChat.vue');
  assert.match(src, /useProjects/, 'AIChat must use the projects composable');
  assert.match(src, /onProjectChange/, 'AIChat must define a project-change handler');
  assert.match(src, /chat-project-select/, 'AIChat must render the project selector');
  assert.match(src, /createConversation\(\{ messages: payload, projectId: activeProjectId\.value \}\)/,
    'new conversations must inherit the active project');
});
