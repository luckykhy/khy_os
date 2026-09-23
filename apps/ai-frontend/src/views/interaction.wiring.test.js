/**
 * Interaction wiring contract — buttons/shortcuts must land on real routes.
 *
 * The audit found the 复核 (review) button in GuiEvalRuns.vue pushes
 * `/gui-eval/review/${row.id}`, a path the router never registers, so the
 * click lands on the catch-all NotFound page. The review UI itself already
 * exists inside GuiEvalRunDetail (人工复核 dialog -> POST /api/gui-eval/runs/:id/review).
 *
 * These tests assert the source-level contract exactly the way
 * router/nav.wiring.test.js does (the files import Vue and `@/` aliases, so
 * the wiring is asserted at source level):
 *
 *   1. every `$router.push(...)` target template in the views either matches
 *      a registered route or is covered by a registered redirect;
 *   2. the 复核 button specifically must navigate to a registered route;
 *   3. that registered route must reach GuiEvalRunDetail (the only view with
 *      the 人工复核 dialog), and the detail view must auto-open the dialog
 *      when the navigation asks for review.
 *
 * Run: npx vitest run src/views/interaction.wiring.test.js
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

function read(rel) {
  return readFileSync(join(srcRoot, rel), 'utf8');
}

const routerSrc = read('router/index.js');

// Resolve the route table to absolute paths, flattening children (same
// bracket-aware approach as nav.wiring.test.js, kept local on purpose so
// each wiring test stays self-contained).
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
          : `${(prefix || '/').replace(/\/+$/, '')}/${route.path}`.replace(/\/+/g, '/');
      flat.push(abs);
      walk(route.children, abs);
    }
  };
  walk(topLevelObjects(array).map(parse), '/');
  return new Set(flat);
}

const routePaths = resolveRoutes(routerSrc);

// A literal path may legally be absorbed by a parameterised sibling route
// registered on the same level (e.g. /admin/channels/new is handled by
// /admin/channels/:id with id='new' — a documented intent in router/index.js).
// Segment-wise matching: replace one segment at a time and accept the push
// target if any such variant exists in the table.
function isAbsorbedByParamRoute(target) {
  if (routePaths.has(target)) return true;
  const segs = target.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const variant = [...segs.slice(0, i), ':id', ...segs.slice(i + 1)].join('/');
    if (!variant.startsWith('/')) {
      if (routePaths.has(`/${variant}`)) return true;
    } else if (routePaths.has(variant)) return true;
  }
  return false;
}

// Every `$router.push(...)` literal or template-literal target in views.
// Template-literal targets like `/gui-eval/runs/${row.id}` are normalised to
// the `/gui-eval/runs/:id` form so they can be matched against the table.
function pushTargets(viewSource) {
  const targets = new Set();
  const pushRe = /\$router\.push\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*[),]/g;
  let m;
  while ((m = pushRe.exec(viewSource))) {
    const raw = m[1].slice(1, -1);
    const normalised = raw.replace(/\$\{[^}]+\}/g, ':id');
    targets.add(normalised);
  }
  return targets;
}

// Views that mix `$router.push` with template literals. Admin views moved to
// views/admin/ when the user/admin shells were split.
const PUSH_VIEWS = [
  'views/admin/GuiEvalRuns.vue',
  'views/admin/GuiEvalDashboard.vue',
  'views/admin/GuiEvalTaskEditor.vue',
  'views/admin/GuiEvalTasks.vue',
  'views/admin/GuiEvalRunDetail.vue',
  'views/admin/WebFrontendEvalRuns.vue',
  'views/admin/WebFrontendEvalDashboard.vue',
  'views/admin/WebFrontendEvalTaskEditor.vue',
  'views/admin/WebFrontendEvalTasks.vue',
  'views/admin/WebFrontendEvalRunDetail.vue',
  'views/admin/ChannelApis.vue',
  'views/admin/ChannelApiEditor.vue',
  'views/KhyOsDesktop.vue',
  'views/KhyOsTerminal.vue',
  'views/UserHome.vue',
];

describe('interaction wiring: every button/router.push target is a registered route', () => {
  for (const rel of PUSH_VIEWS) {
    it(`${rel}: $router.push targets resolve to real routes (no dead-button 404s)`, () => {
      const src = read(rel);
      const targets = pushTargets(src);
      const missing = [...targets].filter((t) => !isAbsorbedByParamRoute(t));
      expect(missing, `dead buttons in ${rel}: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

describe('interaction wiring: the 复核 button reaches the 人工复核 dialog', () => {
  it('GuiEvalRuns 复核 button pushes a registered route', () => {
    const src = read('views/admin/GuiEvalRuns.vue');
    // The button's target, normalised the same way as pushTargets.
    const reviewPush = [...pushTargets(src)].filter((t) => t.includes('review'));
    expect(reviewPush.length, 'the 复核 button must exist and push somewhere').toBeGreaterThan(0);
    const missing = reviewPush.filter((t) => !isAbsorbedByParamRoute(t));
    expect(
      missing,
      `复核 button pushes unregistered ${missing.join(', ')} — user lands on the 404 page`
    ).toEqual([]);
  });

  it('the review route is wired to GuiEvalRunDetail (the only view with the 人工复核 dialog)', () => {
    const detail = read('views/admin/GuiEvalRunDetail.vue');
    expect(detail).toContain('人工复核');
    expect(detail).toContain('submitReview(');

    const runDetailLoader = viewLoaderFor('/admin/gui-eval/runs/:id');
    expect(runDetailLoader, 'viewLoaders must keep the /admin/gui-eval/runs/:id entry').toBeTruthy();

    // Whichever route the 复核 button targets, it must resolve (directly or via
    // redirect) to the run-detail view. A redirect entry is acceptable and is
    // the minimal fix; a dedicated path is fine too.
    const src = read('views/admin/GuiEvalRuns.vue');
    const reviewPush = [...pushTargets(src)].find((t) => t.includes('review'));
    expect(reviewPush).toBeTruthy();

    const ok =
      viewLoaderFor(reviewPush) !== null ||
      redirectsTo(reviewPush, '/admin/gui-eval/runs/:id') ||
      routePaths.has(reviewPush) && loaderTarget(reviewPush) === loaderTarget('/admin/gui-eval/runs/:id');
    expect(ok, `${reviewPush} must resolve (directly or by redirect) to GuiEvalRunDetail`).toBe(true);
  });

  it('GuiEvalRunDetail auto-opens the 人工复核 dialog when navigated for review', () => {
    const detail = read('views/admin/GuiEvalRunDetail.vue');
    // The redirect carries ?review=1; the detail view must read it and open
    // the dialog so the user lands inside the review flow, not just on the page.
    expect(detail).toMatch(/review/);
    expect(detail).toMatch(/submitReviewDialog\.value\s*=\s*true/);
  });
});

// ---------- helpers over the loader registry ----------

const prefetchSrc = read('composables/useRoutePrefetch.js');

function viewLoaderFor(path) {
  const re = new RegExp(`'${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*\\(\\)\\s*=>\\s*import\\('@/([^']+)'\\)`);
  const m = prefetchSrc.match(re);
  return m ? m[1] : null;
}

function loaderTarget(path) {
  return viewLoaderFor(path);
}

// Does the router declare `from` as a redirect whose target is `to`?
// Accepts both shapes used in the table: a string redirect and a function
// redirect returning `{ path, query }`. Child routes are declared without a
// leading slash, so both spellings are tried.
function redirectsTo(from, to) {
  const spellings = [
    from,
    from.replace(/^\//, ''),
    // The admin-shell redirect entries are declared as relative children of the
    // /admin parent route: '/admin/gui-eval/review/:id' is spelled
    // 'gui-eval/review/:id' in the table.
    from.replace(/^\/admin\//, ''),
  ];
  const toVariants = [
    // string-redirect shape: redirect: '/gui-eval/runs/:id' or
    // redirect: (to) => `/gui-eval/runs/${to.params.id}`
    to.replace(/:id/g, '${to.params.id}'),
    // object-redirect shape: redirect: (to) => ({ path: `/…/${to.params.id}` })
    to.replace(/:id/g, '${to.params.id}'),
  ];
  for (const fromRaw of spellings) {
    const fromEsc = fromRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const toRaw of toVariants) {
      const toEsc = toRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const strRedirect = new RegExp(
        `path:\\s*'${fromEsc}'[\\s\\S]*?redirect:\\s*(?:\\(to\\)\\s*=>\\s*)?[\`'"]${toEsc}`
      );
      const objRedirect = new RegExp(
        `path:\\s*'${fromEsc}'[\\s\\S]*?redirect:\\s*\\(to\\)\\s*=>\\s*\\(\\{[\\s\\S]*?path:\\s*\`?${toEsc}`
      );
      if (strRedirect.test(routerSrc) || objRedirect.test(routerSrc)) return true;
    }
  }
  return false;
}
