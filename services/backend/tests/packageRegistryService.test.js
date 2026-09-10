'use strict';
/**
 * packageRegistryService.test.js �?回归 npm/PyPI 仓库查询叶子�?
 *
 * 覆盖:npm search/info 解析、pypi info 解析、pypi search 诚实降级(注入 web 搜索)�?
 * auto 合并、门控关停用、host 白名单拒绝、绝不抛(注入失败�?fetch)�?
 * 全部用注入的 _fetch / _webSearch,零真实网络�?
 */
const svc = require('../src/services/packageRegistryService');
function mkFetch(routes) {
  // routes: [{match:RegExp, status?, json}] ；按序首个匹配�?
  return async (url) => {
    for (const r of routes) {
      if (r.match.test(url)) {
        const status = r.status || 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          async json() { return r.json; },
        };
      }
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };
}
describe('packageRegistryService', () => {
});

describe('Package Registry Service', () => {
  test('npm search parses official JSON search shape', async () => {
        const _fetch = mkFetch([{
          match: /registry\.npmjs\.org\/-\/v1\/search/,
          json: {
            total: 42,
            objects: [{
              package: {
                name: 'yaml', version: '2.4.0', description: 'YAML parser',
                keywords: ['yaml'], links: { npm: 'https://www.npmjs.com/package/yaml', repository: 'https://github.com/eemeli/yaml' },
                publisher: { username: 'eemeli' }, date: '2024-01-01',
              },
              score: { final: 0.9123 },
            }],
          },
        }]);
        const r = await svc.queryRegistry({ registry: 'npm', action: 'search', query: 'yaml', limit: 5, _fetch });
        expect(r.success).toBe(true);
        expect(r.registry).toBe('npm');
        expect(r.total).toBe(42);
        expect(r.results.length).toBe(1);
        expect(r.results[0].name).toBe('yaml');
        expect(r.results[0].version).toBe('2.4.0');
        expect(r.results[0].repository).toBe('https://github.com/eemeli/yaml');
        expect(r.results[0].score).toBe(0.912);
  });

  test('npm info reads dist-tags.latest', async () => {
        const _fetch = mkFetch([{
          match: /registry\.npmjs\.org\/express$/,
          json: {
            name: 'express',
            'dist-tags': { latest: '5.0.0' },
            versions: { '5.0.0': { description: 'web framework', homepage: 'https://expressjs.com', license: 'MIT', keywords: ['web'] } },
          },
        }]);
        const r = await svc.queryRegistry({ registry: 'npm', action: 'info', query: 'express', _fetch });
        expect(r.success).toBe(true);
        expect(r.package.name).toBe('express');
        expect(r.package.version).toBe('5.0.0');
        expect(r.package.license).toBe('MIT');
  });

  test('npm info 404 �?notFound true, success false', async () => {
        const _fetch = mkFetch([{ match: /registry\.npmjs\.org/, status: 404, json: {} }]);
        const r = await svc.queryRegistry({ registry: 'npm', action: 'info', query: 'nope-xyz', _fetch });
        expect(r.success).toBe(false);
        expect(r.notFound).toBe(true);
  });

  test('pypi info parses official JSON info shape', async () => {
        const _fetch = mkFetch([{
          match: /pypi\.org\/pypi\/requests\/json/,
          json: { info: { name: 'requests', version: '2.31.0', summary: 'HTTP for Humans', home_page: 'https://requests.readthedocs.io', license: 'Apache-2.0', requires_python: '>=3.7', author: 'Kenneth Reitz' } },
        }]);
        const r = await svc.queryRegistry({ registry: 'pypi', action: 'info', query: 'requests', _fetch });
        expect(r.success).toBe(true);
        expect(r.package.name).toBe('requests');
        expect(r.package.version).toBe('2.31.0');
        expect(r.package.pypi).toBe('https://pypi.org/project/requests/');
  });

  test('pypi search degrades via injected web search + JSON enrichment', async () => {
        const _webSearch = async (q) => {
          expect(q).toMatch(/site:pypi\.org/);
          return { success: true, results: [
            { url: 'https://pypi.org/project/pyyaml/', title: 'PyYAML' },
            { url: 'https://example.com/not-pypi', title: 'noise' },
            { url: 'https://pypi.org/project/ruamel.yaml/', title: 'ruamel' },
          ] };
        };
        const _fetch = mkFetch([
          { match: /pypi\.org\/pypi\/pyyaml\/json/, json: { info: { name: 'PyYAML', version: '6.0', summary: 'YAML parser' } } },
          { match: /pypi\.org\/pypi\/ruamel\.yaml\/json/, json: { info: { name: 'ruamel.yaml', version: '0.18', summary: 'YAML 1.2' } } },
        ]);
        const r = await svc.queryRegistry({ registry: 'pypi', action: 'search', query: 'yaml', limit: 5, _fetch, _webSearch });
        expect(r.success).toBe(true);
        expect(r.method).toBe('web-search-fallback');
        expect(r.results.length).toBe(2);
        assert.deepEqual(r.results.map(p => p.name).sort(), ['PyYAML', 'ruamel.yaml']);
  });

  test('pypi search with a web search that returns no pypi urls �?honest empty note', async () => {
        // Inject a web search that yields no pypi.org/project hits �?exercises the
        // "parsed no names" honest-empty branch without touching the real network.
        const _webSearch = async () => ({ success: true, results: [{ url: 'https://example.com/x' }] });
        const r = await svc.queryRegistry({ registry: 'pypi', action: 'search', query: 'yaml', _webSearch, _fetch: mkFetch([]) });
        expect(r.success).toBe(true);
        expect(r.registry).toBe('pypi');
        expect(r.action).toBe('search');
        expect(r.results.length).toBe(0);
        expect(r.note).toMatch(/pypi\.org\/project/);
  });

  test('pypi search with a failing web search �?structured error, never throws', async () => {
        const _webSearch = async () => ({ success: false, error: 'search backend down' });
        const r = await svc.queryRegistry({ registry: 'pypi', action: 'search', query: 'yaml', _webSearch, _fetch: mkFetch([]) });
        expect(r.success).toBe(false);
        expect(r.method).toBe('web-search-fallback');
        expect(r.error).toMatch(/search backend down/);
  });

  test('auto search merges npm + pypi', async () => {
        const _webSearch = async () => ({ success: true, results: [] });
        const _fetch = mkFetch([
          { match: /registry\.npmjs\.org\/-\/v1\/search/, json: { total: 1, objects: [{ package: { name: 'yaml', version: '2.0.0' } }] } },
        ]);
        const r = await svc.queryRegistry({ registry: 'auto', action: 'search', query: 'yaml', _fetch, _webSearch });
        expect(r.registry).toBe('auto');
        expect(r.success).toBe(true);
        expect(r.npm.results[0].name).toBe('yaml');
        expect(r.pypi).toBeTruthy();
  });

  test('gate off �?disabled, no network', async () => {
        let called = false;
        const _fetch = async () => { called = true; return { ok: true, status: 200, async json() { return {}; } }; };
        const r = await svc.queryRegistry({ registry: 'npm', action: 'search', query: 'x', env: { KHY_PACKAGE_REGISTRY: '0' }, _fetch });
        expect(r.success).toBe(false);
        expect(r.disabled).toBe(true);
        expect(called).toBe(false);
  });

  test('empty query �?structured error', async () => {
        const r = await svc.queryRegistry({ registry: 'npm', action: 'search', query: '   ' });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/query is required/);
  });

  test('failing fetch never throws �?structured error', async () => {
        const _fetch = async () => { throw new Error('boom network'); };
        const r = await svc.queryRegistry({ registry: 'npm', action: 'search', query: 'yaml', _fetch });
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/boom network/);
  });

  test('_extractPypiNames dedupes and keeps only pypi.org/project urls', async () => {
        const names = svc._extractPypiNames([
          { url: 'https://pypi.org/project/Foo/' },
          { url: 'https://pypi.org/project/foo/' }, // dup (case-insensitive)
          { url: 'https://npmjs.com/package/bar' },
          { link: 'https://pypi.org/project/baz/#history' },
        ]);
        assert.deepEqual(names.map(n => n.toLowerCase()), ['foo', 'baz']);
  });

});

