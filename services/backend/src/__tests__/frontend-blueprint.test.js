'use strict';

/**
 * frontend-blueprint.test.js — fast regression suite pinning the "khyos can
 * autonomously generate a large frontend project" acceptance criteria.
 *
 * Runs in milliseconds (no IO beyond loading the bundled JSON templates /
 * blueprints). It guards three things that quietly rot otherwise:
 *   1) the vue-multipage template renders a real, complete project tree,
 *   2) variable substitution and the zero-hardcode rule hold after render,
 *   3) the archetype's milestone plan stays in lockstep with the template
 *      file set (the invariant that stops someone editing the template but
 *      forgetting the milestones, or vice versa).
 *
 * Style: 2-space indent, single quotes, semicolons; code/comments in English.
 */

const blueprint = require('../services/projectBlueprint');
const projectTemplateService = require('../services/projectTemplateService');

const TEMPLATE_NAME = 'vue-multipage';
const ARCHETYPE_ID = 'vue-multipage';
const EXPECTED_MILESTONES = 7;

describe('vue-multipage template rendering', () => {
  it('renders a complete project tree with key paths present', () => {
    const rendered = projectTemplateService.renderTemplate(TEMPLATE_NAME, {});

    expect(Array.isArray(rendered.files)).toBe(true);
    expect(Array.isArray(rendered.directories)).toBe(true);
    expect(rendered.files.length).toBeGreaterThan(0);
    expect(rendered.directories.length).toBeGreaterThan(0);

    const paths = rendered.files.map((f) => f.path);
    for (const required of [
      'package.json',
      'vite.config.ts',
      'src/router/index.ts',
      'src/layouts/DefaultLayout.vue',
    ]) {
      expect(paths).toContain(required);
    }

    const viewFiles = paths.filter((p) => /^src\/views\/.+\.vue$/.test(p));
    expect(viewFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('substitutes variables and leaves no placeholders behind', () => {
    const rendered = projectTemplateService.renderTemplate(TEMPLATE_NAME, {
      projectName: 'test-app',
      port: '6100',
    });

    const allContent = rendered.files.map((f) => f.content).join('\n');
    expect(allContent).toContain('test-app');
    expect(allContent).toContain('6100');

    for (const file of rendered.files) {
      expect(file.content).not.toContain('{projectName}');
      expect(file.content).not.toContain('{port}');
    }
  });

  it('emits no hard-coded loopback endpoints (zero-hardcode rule)', () => {
    const rendered = projectTemplateService.renderTemplate(TEMPLATE_NAME, {});

    for (const file of rendered.files) {
      expect(file.content).not.toMatch(/localhost:/i);
      expect(file.content).not.toMatch(/https?:\/\/127\.0\.0\.1:/i);
    }
  });
});

describe('vue-multipage blueprint planning', () => {
  it('matches the archetype from a natural-language goal', () => {
    const result = blueprint.match('创建一个大型 Vue 管理后台前端项目');

    expect(result.kind).toBe('archetype');
    expect(result.match).toBeTruthy();
    expect(result.match.id).toBe(ARCHETYPE_ID);
  });

  it('plans exactly 7 milestones, each fully specified', () => {
    const plan = blueprint.plan(ARCHETYPE_ID);

    expect(plan.ok).toBe(true);
    expect(plan.total).toBe(EXPECTED_MILESTONES);
    expect(plan.milestones).toHaveLength(EXPECTED_MILESTONES);

    for (const m of plan.milestones) {
      expect(typeof m.title).toBe('string');
      expect(m.title.length).toBeGreaterThan(0);
      expect(typeof m.goal).toBe('string');
      expect(m.goal.length).toBeGreaterThan(0);
      expect(Array.isArray(m.files)).toBe(true);
      expect(m.files.length).toBeGreaterThan(0);
      expect(Array.isArray(m.acceptance)).toBe(true);
      expect(m.acceptance.length).toBeGreaterThan(0);
    }
  });

  it('returns an executable slice with non-empty text for every milestone', () => {
    for (let i = 0; i < EXPECTED_MILESTONES; i++) {
      const slice = blueprint.milestone(ARCHETYPE_ID, i);
      expect(slice.ok).toBe(true);
      expect(slice.index).toBe(i);
      expect(typeof slice.text).toBe('string');
      expect(slice.text.length).toBeGreaterThan(0);
    }
  });

  it('keeps the milestone file union exactly equal to the template file set', () => {
    const plan = blueprint.plan(ARCHETYPE_ID);
    const rendered = projectTemplateService.renderTemplate(TEMPLATE_NAME, {});
    const templatePaths = new Set(rendered.files.map((f) => f.path));

    // Flatten every milestone's files; assert no duplicates across the plan.
    const unionList = [];
    for (const m of plan.milestones) {unionList.push(...m.files);}
    const unionSet = new Set(unionList);
    expect(unionList.length).toBe(unionSet.size); // no duplicate ownership

    // No milestone path missing from the template (no dangling references).
    for (const p of unionSet) {
      expect(templatePaths.has(p)).toBe(true);
    }
    // No template path left unowned by any milestone (no forgotten files).
    for (const p of templatePaths) {
      expect(unionSet.has(p)).toBe(true);
    }
    // Belt-and-braces: the two sets are the same size.
    expect(unionSet.size).toBe(templatePaths.size);
  });

  it('scaffolds the archetype into non-empty files', () => {
    const result = blueprint.scaffold(ARCHETYPE_ID, {});

    expect(result.ok).toBe(true);
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
  });
});
