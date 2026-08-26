'use strict';

/**
 * Multi-target esbuild configuration for modular packaging.
 *
 * Reads modules.json and dependency-map.json to generate per-module
 * esbuild builds with selective dependency exclusion and tree-shaking.
 *
 * Usage:
 *   node packaging/build/esbuild-modules.js                    # build all modules
 *   node packaging/build/esbuild-modules.js --module khy-ai    # build single module
 *   node packaging/build/esbuild-modules.js --prod             # production (minified)
 *   node packaging/build/esbuild-modules.js --analyze          # print metafile analysis
 *   node packaging/build/esbuild-modules.js --prod --debug-symbols
 *                                                              # 生产包 + 另存 .map
 *
 * source map 与生产产物的关系：`--prod` 默认**不产** map。khy 这一个模块的
 * bundle 是 19.3 MB，它的 map 是 66.9 MB——3.5 倍于产物本身，而发布路径
 * （packaging/npm、便携包）从来只拷 bundle.mjs，map 一直是白建的。
 *
 * 但 map 不能直接丢掉：线上栈回溯没有它就只剩压缩后的行号。所以走分流——
 * `--debug-symbols` 把 map 写到 dist/debug-symbols/<module>/ 下，作为**独立**
 * 的 debug artifact 留档，不进任何运行时产物目录。开发构建（不带 --prod）
 * 仍然内联 map，本地调试体验不变。
 *
 * ── 留档必须能自证新旧 ──────────────────────────────────────────────────
 * `--prod` 不带 `--debug-symbols` 时 esbuild 根本不产 map，所以此刻躺在
 * dist/modules/ 里的那份必定是**上一次**构建的残留，对着的是另一个 bundle。
 * 它会被**删掉，而不是搬进 debug-symbols**：一份错的符号冒充权威留档，比明确
 * 没有符号难查得多——解出来的行号指向另一个函数，而「看起来解开了」。
 *
 * 提升进 debug-symbols 的 map 同时盖一份 `bundle.mjs.map.meta.json`（bundle 的
 * sha256 + 字节数，抹掉 sourceMappingURL **之后**才算，章要对的是出厂的字节）。
 * 后续的 `--prod` 构建拿它比对，对不上就明确告警，但不替人删留档。
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Paths ──
const ROOT = path.resolve(__dirname, '../..');
const BACKEND_ROOT = path.join(ROOT, 'services/backend');
const MODULES_JSON = path.join(ROOT, 'packaging/modules/modules.json');
const DIST_ROOT = path.join(ROOT, 'dist/modules');
// debug 符号刻意放在 dist/modules 之外：便携/发布脚本拷的是 dist/modules/<id>/，
// 同级目录不会被顺手带进产物，留档和分发因此天然分开。
const DEBUG_SYMBOLS_ROOT = path.join(ROOT, 'dist/debug-symbols');

// ── Load configurations ──
const catalog = JSON.parse(fs.readFileSync(MODULES_JSON, 'utf8'));
const backendPkg = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8'));

// ── CLI args ──
const args = process.argv.slice(2);
const isProd = args.includes('--prod') || args.includes('--production');
const isAnalyze = args.includes('--analyze');
// 生产构建默认无 map；显式要 debug 符号时才另存一份到 debug-symbols/。
const wantsDebugSymbols = args.includes('--debug-symbols');
const moduleFilter = (() => {
  const idx = args.indexOf('--module');
  return idx !== -1 ? args[idx + 1] : null;
})();

// ── Node built-ins to mark as external ──
const NODE_BUILTINS = [
  'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls', 'url',
  'child_process', 'stream', 'events', 'util', 'assert', 'buffer',
  'querystring', 'readline', 'zlib', 'dns', 'dgram', 'cluster',
  'worker_threads', 'perf_hooks', 'inspector', 'v8', 'vm', 'tty',
  'string_decoder', 'module', 'constants',
].flatMap(m => [m, `node:${m}`]);

// Native and optional modules are supplied as platform resources. Keeping this
// list explicit prevents an accidentally missing ordinary JS dependency from
// being hidden as a runtime lookup.
const OPTIONAL_RUNTIME_MODULES = [
  'sqlite3',
  'node-llama-cpp',
  'node-pty',
  // @opentelemetry/*：可观测性是 opt-in 能力，默认一个字节都不装
  // （services/backend/package.json 里声明为 peerDependenciesMeta.optional）。
  // 真源是 services/backend/src/observability/otel.js 的 OTEL_OPTIONAL_PACKAGES；
  // 那边加减包时同步改这里，否则发布构建会在解析 require 时失败。
  // 未启用时 otel.js 根本不会走到这些 require，bundle 里留个未解析路径是正确行为。
  '@opentelemetry/sdk-node',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/resources',
  '@opentelemetry/semantic-conventions',
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/instrumentation-express',
  '@opentelemetry/exporter-trace-otlp-http',
];

/**
 * 一份 bundle 的身份章:留档的 map 靠它自证对应哪个产物。
 * 只用内容摘要和字节数,不掺时间戳 —— 同样的输入两次构建应当盖出同样的章。
 */
function bundleStamp(outfile, moduleId) {
  const buf = fs.readFileSync(outfile);
  return {
    module: moduleId,
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}
/**
 * Compute the external dependencies for a module.
 * Deps listed in excludeDeps are bundled out (marked external).
 * Deps NOT in excludeDeps are included in the bundle.
 */
function computeExternals(moduleConfig) {
  // All node built-ins are always external
  const externals = [...NODE_BUILTINS, ...OPTIONAL_RUNTIME_MODULES];

  // Every ordinary JavaScript dependency is bundled for install-time zero
  // dependency releases. Module manifests may still describe feature scope,
  // while optional native modules remain explicit runtime resources.
  return [...new Set(externals)];
}

/**
 * Resolve the entry point path for a module.
 * The entry field in modules.json is relative to packaging/modules/entries/.
 */
function resolveEntry(moduleConfig) {
  const entryRelative = moduleConfig.entry;
  return path.resolve(ROOT, 'packaging/modules/entries', entryRelative);
}

/**
 * Build a single module.
 */
async function buildModule(moduleConfig) {
  const moduleId = moduleConfig.id;
  const outDir = path.join(DIST_ROOT, moduleId);

  // Ensure output directory
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const entryPoint = resolveEntry(moduleConfig);
  if (!fs.existsSync(entryPoint)) {
    console.error(`  \u2717 Entry not found: ${entryPoint}`);
    return null;
  }

  const externals = computeExternals(moduleConfig);
  const outfile = path.join(outDir, 'bundle.mjs');

  const config = {
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    target: catalog.nodeTarget || 'node22',
    format: 'esm',
    external: externals,
    alias: {
      'react-devtools-core': path.join(__dirname, 'shims/react-devtools-core.mjs'),
    },
    // 开发构建照旧带 map；生产构建只有显式 --debug-symbols 才产，且产完就移走。
    sourcemap: !isProd || wantsDebugSymbols,
    metafile: true,
    treeShaking: true,
    minify: isProd,
    minifyWhitespace: isProd,
    minifyIdentifiers: false, // Keep identifiers readable
    minifySyntax: isProd,
    logLevel: 'warning',
    banner: {
      js: `import { createRequire as __khyCreateRequire } from 'node:module';\nimport { fileURLToPath as __khyFileURLToPath } from 'node:url';\nimport { dirname as __khyDirname } from 'node:path';\nconst require = __khyCreateRequire(import.meta.url);\nconst __filename = __khyFileURLToPath(import.meta.url);\nconst __dirname = __khyDirname(__filename);\n/* KHY OS Module: ${moduleId} v${catalog.version} | ${new Date().toISOString().split('T')[0]} */`,
    },
    define: {
      'process.env.KHY_BUNDLED': '"true"',
      'process.env.NODE_ENV': '"production"',
      'process.env.KHY_MODULE': `"${moduleId}"`,
    },
  };

  try {
    const result = await esbuild.build(config);

    // Write metafile for analysis
    const metaPath = path.join(outDir, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(result.metafile));

    // 生产构建：把 map 移出运行时目录，并抹掉 bundle 末尾的 sourceMappingURL。
    //
    // 那行注释必须去掉，而不是留着不管：发布产物里根本没有 .map 文件，留着它
    // 就是一条指向空气的引用——调试器和 Sentry 一类工具会照着去取，拿到 404，
    // 把「符号没上传」这件事伪装成「符号损坏」。宁可明确没有，不要假装有。
    if (isProd) {
      const mapPath = outfile + '.map';
      const symbolDir = path.join(DEBUG_SYMBOLS_ROOT, moduleId);
      const symbolMap = path.join(symbolDir, 'bundle.mjs.map');
      const symbolStamp = symbolMap + '.meta.json';

      let promotedSymbols = false;
      if (wantsDebugSymbols) {
        if (fs.existsSync(mapPath)) {
          fs.mkdirSync(symbolDir, { recursive: true });
          fs.renameSync(mapPath, symbolMap);
          promotedSymbols = true;
          console.log(`    debug symbols → ${path.relative(ROOT, symbolMap)}`);
        }
      } else if (fs.existsSync(mapPath)) {
        // 本次构建根本没产 map(sourcemap: false),所以躺在这里的是**上一次**构建
        // 留下的 —— 它对着的是另一个 bundle。把它搬进 debug-symbols 会让一份错的
        // 符号冒充权威留档:拿它去解压缩后的栈回溯,得到的行号指向另一个函数,而
        // 「看起来解开了」比「明确没有符号」难查得多。所以是删,不是搬。
        //
        // 它也不能留在 dist/modules/ 里:那是发布脚本拷贝的源目录,64 MB 的 map
        // 离进分发包只差有人把 copyFileSync 写成 copyTree。
        fs.rmSync(mapPath, { force: true });
        console.log('    stale source map removed (本次未请求 --debug-symbols)');
      }
      const code = fs.readFileSync(outfile, 'utf8');
      const stripped = code.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');
      if (stripped !== code) fs.writeFileSync(outfile, stripped);

      // 盖章必须在**抹掉 sourceMappingURL 之后**:章要对的是真正出厂的那份字节。
      // 抹除前盖章会让摘要永远对不上下一次构建算出的值 —— 过期告警于是每次误报,
      // 而一条天天喊狼来了的告警等于没有告警。
      if (promotedSymbols) {
        fs.writeFileSync(symbolStamp, JSON.stringify(bundleStamp(outfile, moduleId), null, 2));
      }

      // 留档告警:上一轮 --debug-symbols 存下的 map 现在对不上新 bundle 了。
      // 不替人删别人的留档,但也绝不让它被继续信任。
      if (!wantsDebugSymbols && fs.existsSync(symbolStamp)) {
        try {
          const stamped = JSON.parse(fs.readFileSync(symbolStamp, 'utf8'));
          const current = bundleStamp(outfile, moduleId);
          if (stamped.sha256 !== current.sha256) {
            console.log(`    ⚠ ${path.relative(ROOT, symbolMap)} 已过期（对应 bundle ${String(stamped.sha256).slice(0, 12)}，现在是 ${current.sha256.slice(0, 12)}）`);
            console.log('      拿它解当前的栈回溯会得到错行号。重建：--prod --debug-symbols');
          }
        } catch {
          /* 章读不动就不告警,构建不该因为一个留档元数据挂掉 */
        }
      }
    }

    // Report size
    const stat = fs.statSync(outfile);
    const sizeKB = (stat.size / 1024).toFixed(1);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
    console.log(`  \u2713 ${moduleId.padEnd(14)} ${sizeKB.padStart(10)} KB  (${sizeMB} MB)  \u2192 ${path.relative(ROOT, outfile)}`);

    // Print analysis if requested
    if (isAnalyze && result.metafile) {
      const text = await esbuild.analyzeMetafile(result.metafile, { verbose: false });
      console.log(text);
    }

    return result;
  } catch (err) {
    console.error(`  \u2717 ${moduleId}: ${err.message}`);
    return null;
  }
}

// ── Main ──
async function main() {
  const startTime = Date.now();

  // Filter modules
  let modules = catalog.modules;
  if (moduleFilter) {
    modules = modules.filter(m => m.id === moduleFilter);
    if (modules.length === 0) {
      console.error(`Module "${moduleFilter}" not found. Available: ${catalog.modules.map(m => m.id).join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`\n  Building ${modules.length} module(s) (${isProd ? 'production' : 'development'})...\n`);

  // Ensure dist root
  if (!fs.existsSync(DIST_ROOT)) fs.mkdirSync(DIST_ROOT, { recursive: true });

  // Build modules sequentially to avoid resource contention
  const results = [];
  for (const mod of modules) {
    const result = await buildModule(mod);
    results.push({ id: mod.id, result });
  }

  const elapsed = Date.now() - startTime;
  const succeeded = results.filter(r => r.result !== null).length;
  const failed = results.filter(r => r.result === null).length;

  console.log(`\n  Done in ${elapsed}ms \u2014 ${succeeded} succeeded, ${failed} failed\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
