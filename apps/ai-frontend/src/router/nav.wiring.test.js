/**
 * Router ↔ NAV ↔ viewLoaders contract (frontend).
 *
 * These files import Vue and the `@/` alias, so they can't be imported directly
 * under the plain Node test runner — instead the wiring is asserted at the
 * source level, which is exactly what breaks silently if a future edit drops a
 * link. The contract under test:
 *
 *   - NAV is the single declaration of pages; the router derives requiresAdmin
 *     from it (no hand-written markers), so a new page is one edit, not two.
 *   - every page in NAV is actually routable.
 *   - every route resolves to a real view chunk that exists on disk.
 *   - the /403 gate still sends non-admins to a page that cannot itself be
 *     gated or bounce them home.
 *
 * Zero deps — run with the built-in Node test runner (apps/ai-frontend is
 * type:module):
 *   npx vitest run src/router/nav.wiring.test.js
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NAV, visibleNavGroups } from '@/nav';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..'); // apps/ai-frontend/src

function read(rel) {
  return readFileSync(join(appRoot, rel), 'utf8');
}

// ---------- bracket-aware helpers ----------
function sliceBalanced(text, open, close, from) {
  const start = text.indexOf(open, from);
  if (start < 0) return null;
  let depth = 0;
  for (let k = start; k < text.length; k += 1) {
    if (text[k] === open) depth += 1;
    else if (text[k] === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, k + 1);
    }
  }
  return null;
}

function topLevelObjects(arrayText) {
  const inner = arrayText.slice(arrayText.indexOf('[') + 1, arrayText.lastIndexOf(']'));
  const out = [];
  let depth = 0;
  let begin = -1;
  for (let k = 0; k < inner.length; k += 1) {
    if (inner[k] === '{') {
      if (depth === 0) begin = k;
      depth += 1;
    } else if (inner[k] === '}') {
      depth -= 1;
      if (depth === 0 && begin >= 0) {
        out.push(inner.slice(begin, k + 1));
        begin = -1;
      }
    }
  }
  return out;
}

function joinPath(parent, child) {
  return `${(parent || '/').replace(/\/+$/, '')}/${child}`.replace(/\/+/g, '/');
}

// Resolve the route table to absolute paths, flattening children.
function resolveRoutes(source) {
  const array = sliceBalanced(source, '[', ']', source.indexOf('const routes = ['));
  const parse = (objText) => {
    const own = objText.match(/path:\s*'([^']*)'/);
    const childIdx = objText.indexOf('children:');
    const childText = childIdx >= 0 ? sliceBalanced(objText, '[', ']', childIdx) : null;
    return {
      path: own ? own[1] : null,
      children: childText ? topLevelObjects(childText).map(parse) : [],
    };
  };
  const flat = [];
  const walk = (routes, prefix) => {
    for (const route of routes) {
      const abs = !route.path
        ? prefix
        : route.path.startsWith('/')
          ? route.path
          : joinPath(prefix || '/', route.path);
      flat.push(abs);
      walk(route.children, abs);
    }
  };
  walk(topLevelObjects(array).map(parse), '/');
  return new Set(flat);
}

// NAV groups with their declared role tier.
function resolveNavGroups(source) {
  const array = sliceBalanced(source, '[', ']', source.indexOf('const NAV'));
  return topLevelObjects(array).map((groupText) => {
    const label = (groupText.match(/label:\s*'([^']*)'/) || [])[1];
    const role = (groupText.match(/requiredRole:\s*ROLE\.(\w+)/) || [])[1] || 'USER';
    const itemsText = sliceBalanced(groupText, '[', ']', groupText.indexOf('items:'));
    const items = (itemsText ? topLevelObjects(itemsText) : [])
      .map((itemText) => (itemText.match(/path:\s*'([^']*)'/) || [])[1])
      .filter(Boolean);
    return { label, role, items };
  });
}

const routerSrc = read('router/index.js');
const prefetchSrc = read('composables/useRoutePrefetch.js');
const navSrc = read('nav/index.js');

const routesBody = sliceBalanced(routerSrc, '[', ']', routerSrc.indexOf('const routes = ['));
const routePaths = resolveRoutes(routerSrc);
const navGroups = resolveNavGroups(navSrc);
const navAllPaths = navGroups.flatMap((g) => g.items);
const navAdminPaths = navGroups.filter((g) => g.role === 'ADMIN').flatMap((g) => g.items);

// ---------- the contract ----------
test('NAV declares every page in exactly one group', () => {
  assert.ok(navGroups.length >= 2, 'NAV must have at least the user and admin groups');
  assert.ok(navAdminPaths.length > 0, 'NAV must have an admin group');
  const dupes = navAllPaths.filter((p, i) => navAllPaths.indexOf(p) !== i);
  assert.deepEqual(dupes, [], 'NAV paths must not repeat across groups');
});

test('no route declares requiresAdmin by hand — it is derived from NAV', () => {
  assert.doesNotMatch(
    routesBody,
    /meta:\s*\{\s*requiresAdmin:\s*true\s*\}/,
    'requiresAdmin must come from the NAV stamp, never a per-route marker'
  );
  assert.match(
    routerSrc,
    /import \{[^}]*\bNAV\b[^}]*\} from '@\/nav'/,
    'router must import NAV'
  );
  assert.match(
    routerSrc,
    /stampAdminMeta\(|isAdminPath\(/,
    'router must stamp requiresAdmin onto the route records'
  );
});

test('every NAV admin page is gated by the NAV-derived prefix rule', () => {
  // The stamp covers an admin path itself and anything nested under it, so the
  // detail drill-downs (eval tasks/runs, channel API detail) inherit the gate.
  for (const path of navAdminPaths) {
    assert.ok(
      routePaths.has(path),
      `NAV admin page ${path} must be a real route (guard would bounce it to 404)`
    );
  }
  // Detail routes that are admin-only but not sidebar entries are declared once
  // in EXTRA_ADMIN_PATHS rather than scattered as markers.
  assert.match(
    routerSrc,
    /EXTRA_ADMIN_PATHS\s*=\s*\[[\s\S]*?'\/agents'[\s\S]*?'\/traffic'[\s\S]*?\]/,
    'detail-only admin routes must be declared in EXTRA_ADMIN_PATHS'
  );
});

test('every NAV page is routable', () => {
  const missing = navAllPaths.filter((path) => !routePaths.has(path));
  assert.deepEqual(missing, [], `NAV pages with no route: ${missing.join(', ')}`);
});

test('legacy admin paths forward to their /admin/* homes', () => {
  // Bookmarks and copy-pasted URLs from before the rename must not 404. Each
  // entry redirects to a route that exists, so the admin guard re-checks the
  // role at the destination — a redirect cannot be used to reach an admin page
  // without the 403 gate.
  const LEGACY = [
    ['/dashboard', '/admin/overview'],
    ['/gateway', '/admin/models'],
    ['/accounts', '/admin/accounts'],
    ['/settings', '/admin/settings'],
    ['/wx-binding', '/admin/settings/wx'],
    ['/my-gateway', '/keys'],
    ['/admin/channel-apis', '/admin/channels'],
  ];
  for (const [from, to] of LEGACY) {
    assert.match(
      routerSrc,
      new RegExp(`path:\\s*'${from.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}'[\\s\\S]*?redirect:\\s*'${to.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}'`),
      `${from} must redirect to ${to}`
    );
    assert.ok(!navAllPaths.includes(from), `${from} must not reappear in NAV`);
    assert.ok(routePaths.has(to), `${to} (redirect target of ${from}) must be a real route`);
  }
  // The detail path keeps its id instead of collapsing to the list.
  assert.match(
    routerSrc,
    /redirect:\s*\(to\)\s*=>\s*`\/admin\/channels\/\$\{to\.params\.id\}`/,
    '/admin/channel-apis/:id must preserve the id'
  );
  assert.ok(
    routePaths.has('/admin/channels/:id'),
    'the parameterised detail route must still exist'
  );
});

test('every route resolves to a real view chunk on disk', () => {
  const referenced = new Set(
    [...routerSrc.matchAll(/viewLoaders\['([^']+)'\]/g)].map((m) => m[1])
  );
  assert.ok(referenced.size > 10, 'router must resolve its views through viewLoaders');

  const declared = new Map();
  for (const match of prefetchSrc.matchAll(
    /'([^']+)':\s*\(\)\s*=>\s*import\('@\/(views\/[^']+\.vue)'\)/g
  )) {
    declared.set(match[1], match[2]);
  }

  const unregistered = [...referenced].filter((key) => !declared.has(key));
  assert.deepEqual(
    unregistered,
    [],
    `router references viewLoaders keys that are not registered: ${unregistered.join(', ')}`
  );

  const missingFiles = [...declared.entries()]
    .filter(([key]) => referenced.has(key))
    .filter(([, rel]) => !existsSync(join(appRoot, rel)));
  assert.deepEqual(
    missingFiles,
    [],
    `viewLoaders entries pointing at missing files: ${missingFiles
      .map(([key, rel]) => `${key} -> ${rel}`)
      .join(', ')}`
  );
});

test('non-admins land on /403, which is renderable and cannot bounce home', () => {
  assert.match(routerSrc, /if \(requiresAdmin && !userStore\.isAdmin\) return next\('\/403'\)/);
  assert.match(
    routerSrc,
    /path:\s*'\/403'[\s\S]*?meta:\s*\{\s*requiresAuth:\s*false\s*\}/,
    '/403 must be public so the guard cannot re-enter the admin check'
  );
  assert.match(
    routerSrc,
    /isGuestRoute:\s*to\.path === '\/login' \|\| to\.path === '\/401'/,
    '/403 and /500 must NOT be guest routes or the error page is hidden'
  );
});

test('redirect targets are sanitised everywhere they are read', () => {
  assert.match(routerSrc, /safeRedirectPath\(to\.fullPath/, 'guard must sanitise ?redirect');
  const login = read('views/Login.vue');
  assert.match(login, /safeRedirectPath\(route\.query\.redirect/, 'login must sanitise ?redirect');
  const notAuth = read('views/NotAuthenticated.vue');
  assert.match(notAuth, /safeRedirectPath\(route\.query\.redirect/, '/401 must sanitise ?redirect');
});

// ---------- D1 = 方案 Y: daemon-only namespaces ----------
const ADMIN = { role: 'admin' };
const USER = { role: 'user' };

function pathsOf(groups) {
  return groups.flatMap((g) => g.items.map((i) => i.path));
}

test('the console group is gated by role, not by probe state', () => {
  const admin = visibleNavGroups(ADMIN);
  const user = visibleNavGroups(USER);
  assert.ok(admin.some((g) => g.label === '管理控制台'), 'admin sees the console group');
  assert.ok(!user.some((g) => g.label === '管理控制台'), 'a user never sees it');
  assert.ok(admin.length > user.length);
});

test('daemon-only entries are hidden only when their namespace is unavailable', () => {
  const paths = pathsOf(visibleNavGroups(USER));
  assert.ok(paths.includes('/workflows'), 'fail-open: shown before the probe settles');
  assert.ok(paths.includes('/marketplace'));

  const hidden = pathsOf(
    visibleNavGroups(USER, { workflow: false, marketplace: false })
  );
  assert.ok(!hidden.includes('/workflows'), '/workflows hides when the daemon is absent');
  assert.ok(!hidden.includes('/marketplace'), '/marketplace hides too');
  assert.ok(hidden.includes('/chat'), 'unrelated entries are unaffected');
  assert.ok(
    hidden.includes('/proxies'),
    '/proxies is mixed (subscriptions are monolith, egress self-degrades) and stays visible'
  );
});

test('NAV declares the namespace each hideable entry depends on', () => {
  const flagged = NAV.flatMap((g) =>
    g.items.filter((i) => i.daemon).map((i) => [i.path, i.daemon])
  );
  assert.deepEqual(
    flagged,
    [
      ['/workflows', 'workflow'],
      ['/marketplace', 'marketplace'],
    ],
    'only the two fully-daemon entries may be flagged'
  );
});

test('the probe drives the sidebar and fails open on ambiguity', () => {
  const probe = read('api/daemonProbe.js');
  assert.match(probe, /workflow:\s*'\/api\/workflow'/, 'probe covers /api/workflow');
  assert.match(probe, /marketplace:\s*'\/api\/marketplace'/, 'probe covers /api/marketplace');
  assert.match(probe, /silent:\s*true/, 'the probe must not raise a toast');
  assert.match(
    probe,
    /status !== 404 && status !== 405/,
    'only a definite 404/405 hides an entry — 5xx and network errors stay visible'
  );
  assert.match(probe, /SESSION_KEY = 'khy_ai_daemon_probe'/, 'results are cached per session');

  const layout = read('views/Layout.vue');
  assert.match(layout,   /from\s+'@\/api\/daemonProbe'/ ,   'Layout must probe');
  assert.match(
    layout,
    /visibleNavGroups\(userStore\.user, daemonCaps\)/,
    'the sidebar must filter on the probe result'
  );
});
