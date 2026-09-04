'use strict';

/**
 * project.js — Project analysis command handler.
 *
 * Provides `project` command for analyzing large codebases without
 * overwhelming the AI context window.
 *
 * Subcommands:
 *   project map [path]          — Show project structure map
 *   project analyze [query]     — AI-powered analysis with project context
 *   project structure [path]    — Detailed structure analysis
 *   project index               — Ultra-compact project index
 *   project scan [pattern]      — Scan for files matching pattern
 *
 * The key insight: instead of dumping all code into context, we:
 * 1. Generate a lightweight project map (~200-500 tokens)
 * 2. Inject it as context for the AI
 * 3. Let the AI use tools (Read/Glob/Grep) to explore details on demand
 * 4. Context compression handles the rest automatically
 *
 * @module handlers/project
 */

const path = require('path');
const fs = require('fs');

const chalk = require('chalk').default || require('chalk');
const { printSuccess, printError, printInfo, printWarn, printTable } = require('../formatters');
const { formatStatusMessage } = require('../statusMessageFormatter');

// Lazy-load heavy service
let _projectMapService = null;
function _getMapService() {
  if (!_projectMapService) {
    _projectMapService = require('../../services/projectAnalysis/projectMapService');
  }
  return _projectMapService;
}

// ── Map Command ─────────────────────────────────────────────────────────

async function handleProjectMap(args = [], options = {}) {
  const targetPath = args[0] || process.cwd();
  const resolvedPath = path.resolve(targetPath);

  if (!fs.existsSync(resolvedPath)) {
    printError(`路径不存在: ${resolvedPath}`);
    return true;
  }

  const maxDepth = parseInt(options.depth || options.d || '3', 10);
  const maxNodes = parseInt(options.nodes || options.n || '80', 10);

  printInfo(formatStatusMessage('扫描', `项目结构 (${resolvedPath})`, '读取目录树'));
  const mapService = _getMapService();
  const map = mapService.generateProjectMap(resolvedPath, {
    maxDepth: Number.isFinite(maxDepth) ? maxDepth : 3,
    maxNodes: Number.isFinite(maxNodes) ? maxNodes : 80,
    includeManifest: options.manifest !== false,
    includeTree: options.tree !== false,
    includeStats: options.stats !== false,
  });

  if (options.json) {
    console.log(JSON.stringify({ map }, null, 2));
    return true;
  }

  console.log('');
  console.log(chalk.cyan.bold('  🗺️  项目地图'));
  console.log(chalk.dim('  ' + '─'.repeat(40)));
  console.log('');
  console.log(map);
  console.log('');
  printInfo('提示: 使用 "project analyze <问题>" 让 AI 基于此地图分析项目');
  return true;
}

// ── Analyze Command ─────────────────────────────────────────────────────

async function handleProjectAnalyze(args = [], options = {}) {
  const query = args.join(' ') || '分析这个项目的架构、技术栈和代码组织方式';
  const targetPath = options.path || options.p || process.cwd();
  const resolvedPath = path.resolve(targetPath);

  if (!fs.existsSync(resolvedPath)) {
    printError(`路径不存在: ${resolvedPath}`);
    return true;
  }

  printInfo(formatStatusMessage('生成', '项目地图', '扫描目录结构'));
  const mapService = _getMapService();
  const map = mapService.generateProjectMap(resolvedPath, {
    maxDepth: 3,
    maxNodes: 80,
  });

  // Build the AI prompt with project context
  const aiPrompt = buildAnalysisPrompt(query, map, resolvedPath);

  // Forward to AI
  return { aiForward: aiPrompt };
}

// ── Structure Command ───────────────────────────────────────────────────

async function handleProjectStructure(args = [], options = {}) {
  const targetPath = args[0] || process.cwd();
  const resolvedPath = path.resolve(targetPath);

  if (!fs.existsSync(resolvedPath)) {
    printError(`路径不存在: ${resolvedPath}`);
    return true;
  }

  const maxDepth = parseInt(options.depth || options.d || '4', 10);
  const maxNodes = parseInt(options.nodes || options.n || '120', 10);

  printInfo(formatStatusMessage('分析', '项目结构', '深度扫描'));
  const mapService = _getMapService();
  const map = mapService.generateProjectMap(resolvedPath, {
    maxDepth: Number.isFinite(maxDepth) ? maxDepth : 4,
    maxNodes: Number.isFinite(maxNodes) ? maxNodes : 120,
    includeManifest: true,
    includeTree: true,
    includeStats: true,
  });

  if (options.json) {
    console.log(JSON.stringify({ map }, null, 2));
    return true;
  }

  console.log('');
  console.log(chalk.cyan.bold('  🏗️  项目结构分析'));
  console.log(chalk.dim('  ' + '─'.repeat(40)));
  console.log('');
  console.log(map);
  console.log('');

  // Additional analysis
  const analysis = analyzeStructure(resolvedPath);
  if (analysis.languages.length > 0) {
    console.log(chalk.bold('  语言分布:'));
    for (const lang of analysis.languages) {
      console.log(`    ${chalk.cyan(lang.name)}: ${lang.percentage}% (${lang.files} 文件)`);
    }
    console.log('');
  }

  if (analysis.frameworks.length > 0) {
    console.log(chalk.bold('  检测到的框架:'));
    for (const fw of analysis.frameworks) {
      console.log(`    ${chalk.green(fw.name)} — ${fw.description}`);
    }
    console.log('');
  }

  return true;
}

// ── Index Command ───────────────────────────────────────────────────────

async function handleProjectIndex(args = [], options = {}) {
  const targetPath = args[0] || process.cwd();
  const resolvedPath = path.resolve(targetPath);

  if (!fs.existsSync(resolvedPath)) {
    printError(`路径不存在: ${resolvedPath}`);
    return true;
  }

  const mapService = _getMapService();
  const miniMap = mapService.generateMiniMap(resolvedPath);

  if (options.json) {
    console.log(JSON.stringify({ map: miniMap }, null, 2));
    return true;
  }

  console.log('');
  console.log(miniMap);
  console.log('');
  return true;
}

// ── Scan Command ────────────────────────────────────────────────────────

async function handleProjectScan(args = [], options = {}) {
  const pattern = args[0] || '*.js';
  const targetPath = options.path || options.p || process.cwd();
  const resolvedPath = path.resolve(targetPath);

  if (!fs.existsSync(resolvedPath)) {
    printError(`路径不存在: ${resolvedPath}`);
    return true;
  }

  printInfo(formatStatusMessage('扫描', `匹配 "${pattern}" 的文件`, '遍历目录'));
  const files = scanFiles(resolvedPath, pattern, {
    maxResults: parseInt(options.limit || options.l || '50', 10),
    maxDepth: parseInt(options.depth || options.d || '5', 10),
  });

  if (files.length === 0) {
    printInfo(`未找到匹配 "${pattern}" 的文件`);
    return true;
  }

  if (options.json) {
    console.log(JSON.stringify({ pattern, count: files.length, files }, null, 2));
    return true;
  }

  console.log('');
  console.log(chalk.cyan.bold(`  🔍 扫描结果: ${pattern}`));
  console.log(chalk.dim(`  共 ${files.length} 个文件`));
  console.log(chalk.dim('  ' + '─'.repeat(40)));
  for (const file of files) {
    console.log(`  ${chalk.dim(file.dir)}/${chalk.white(file.name)}`);
  }
  console.log('');

  if (files.length >= parseInt(options.limit || options.l || '50', 10)) {
    printInfo('结果已截断，使用 --limit N 增加显示数量');
  }

  return true;
}

// ── Help ────────────────────────────────────────────────────────────────

function _printHelp() {
  console.log('');
  console.log(chalk.cyan.bold('  📁 项目分析命令'));
  console.log(chalk.dim('  ' + '─'.repeat(40)));
  console.log('');
  console.log(`  ${chalk.green('project map [path]')}`);
  console.log(`    显示项目结构地图（目录树 + 入口点 + 依赖）`);
  console.log('');
  console.log(`  ${chalk.green('project analyze [query]')}`);
  console.log(`    AI 分析项目（自动注入项目地图作为上下文）`);
  console.log('');
  console.log(`  ${chalk.green('project structure [path]')}`);
  console.log(`    详细结构分析（含语言分布、框架检测）`);
  console.log('');
  console.log(`  ${chalk.green('project index')}`);
  console.log(`    超紧凑项目索引（~100 tokens，适合上下文紧张时）`);
  console.log('');
  console.log(`  ${chalk.green('project scan <pattern>')}`);
  console.log(`    扫描匹配模式的文件（如 "*.vue", "test_*.py"）`);
  console.log('');
  console.log(chalk.dim('  选项:'));
  console.log(chalk.dim('    --path, -p <path>   指定项目路径（默认当前目录）'));
  console.log(chalk.dim('    --depth, -d <n>     目录树深度（默认 3）'));
  console.log(chalk.dim('    --nodes, -n <n>     最大节点数（默认 80）'));
  console.log(chalk.dim('    --json               JSON 输出'));
  console.log('');
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build an AI prompt that includes the project map as context.
 * The prompt instructs the AI to use tools for detailed exploration.
 */
function buildAnalysisPrompt(query, projectMap, rootPath) {
  return `## 项目分析任务

用户请求: ${query}

## 项目上下文（自动生成，${projectMap.split('\n').length} 行）

\`\`\`
${projectMap}
\`\`\`

## 分析指南

1. 以上项目地图提供了项目的**结构概览**（目录树、入口点、依赖）
2. 如需查看具体文件内容，请使用 Read 工具读取
3. 如需搜索代码模式，请使用 Grep 工具
4. 如需查找文件，请使用 Glob 工具
5. 分析应基于实际代码，不要凭空猜测

## 工作目录: ${rootPath}

请基于以上信息分析项目。如果需要更多上下文，主动使用工具探索。`;
}

/**
 * Analyze project structure for language distribution and frameworks.
 */
function analyzeStructure(root) {
  const langCounts = {};
  const frameworks = [];
  let totalFiles = 0;

  function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', 'out']);
        if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else {
        totalFiles++;
        const ext = path.extname(entry.name).toLowerCase();
        const langMap = {
          '.js': 'JavaScript',
          '.ts': 'TypeScript',
          '.jsx': 'React JSX',
          '.tsx': 'React TSX',
          '.vue': 'Vue',
          '.py': 'Python',
          '.rs': 'Rust',
          '.go': 'Go',
          '.java': 'Java',
          '.c': 'C',
          '.cpp': 'C++',
          '.h': 'C/C++ Header',
          '.cs': 'C#',
          '.rb': 'Ruby',
          '.php': 'PHP',
          '.swift': 'Swift',
          '.kt': 'Kotlin',
          '.scala': 'Scala',
          '.html': 'HTML',
          '.css': 'CSS',
          '.scss': 'SCSS',
          '.sass': 'Sass',
          '.less': 'Less',
          '.json': 'JSON',
          '.yaml': 'YAML',
          '.yml': 'YAML',
          '.toml': 'TOML',
          '.xml': 'XML',
          '.md': 'Markdown',
          '.sql': 'SQL',
          '.sh': 'Shell',
          '.bash': 'Bash',
          '.zsh': 'Zsh',
          '.fish': 'Fish',
          '.ps1': 'PowerShell',
          '.dockerfile': 'Dockerfile',
        };
        const lang = langMap[ext] || null;
        if (lang) {
          langCounts[lang] = (langCounts[lang] || 0) + 1;
        }
      }
    }
  }

  walk(root, 0);

  // Detect frameworks from package.json
  try {
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const frameworkDetectors = [
        { name: 'React', deps: ['react', 'react-dom'], description: 'UI 框架' },
        { name: 'Vue', deps: ['vue', 'nuxt'], description: 'UI 框架' },
        { name: 'Angular', deps: ['@angular/core'], description: 'UI 框架' },
        { name: 'Next.js', deps: ['next'], description: 'React 全栈框架' },
        { name: 'Nuxt', deps: ['nuxt', 'nuxt3'], description: 'Vue 全栈框架' },
        { name: 'Express', deps: ['express'], description: 'Node.js Web 框架' },
        { name: 'Fastify', deps: ['fastify'], description: 'Node.js Web 框架' },
        { name: 'Koa', deps: ['koa'], description: 'Node.js Web 框架' },
        { name: 'Vite', deps: ['vite'], description: '构建工具' },
        { name: 'Webpack', deps: ['webpack'], description: '构建工具' },
        { name: 'TypeScript', deps: ['typescript'], description: '类型系统' },
        { name: 'Tailwind CSS', deps: ['tailwindcss'], description: 'CSS 框架' },
        { name: 'ESLint', deps: ['eslint'], description: '代码检查' },
        { name: 'Prettier', deps: ['prettier'], description: '代码格式化' },
        { name: 'Jest', deps: ['jest'], description: '测试框架' },
        { name: 'Vitest', deps: ['vitest'], description: '测试框架' },
      ];
      for (const fw of frameworkDetectors) {
        if (fw.deps.some((d) => allDeps[d])) {
          frameworks.push(fw);
        }
      }
    }
  } catch {
    // ignore
  }

  // Detect Python frameworks
  try {
    const pyprojectPath = path.join(root, 'pyproject.toml');
    const setupPath = path.join(root, 'setup.py');
    if (fs.existsSync(pyprojectPath) || fs.existsSync(setupPath)) {
      const pyFw = [
        { name: 'Django', pattern: 'django' },
        { name: 'Flask', pattern: 'flask' },
        { name: 'FastAPI', pattern: 'fastapi' },
        { name: 'SQLAlchemy', pattern: 'sqlalchemy' },
        { name: 'Pytest', pattern: 'pytest' },
      ];
      for (const fw of pyFw) {
        try {
          const content = fs.readFileSync(fs.existsSync(pyprojectPath) ? pyprojectPath : setupPath, 'utf-8');
          if (content.toLowerCase().includes(fw.pattern)) {
            frameworks.push({ name: fw.name, description: 'Python 库/框架' });
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  const languages = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({
      name,
      files: count,
      percentage: totalFiles > 0 ? Math.round((count / totalFiles) * 100) : 0,
    }));

  return { languages, frameworks, totalFiles };
}

/**
 * Scan for files matching a glob-like pattern.
 */
function scanFiles(root, pattern, options = {}) {
  const { maxResults = 50, maxDepth = 5 } = options;
  const results = [];

  // Convert simple glob to regex
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special chars
    .replace(/\*/g, '.*')                    // * → .*
    .replace(/\?/g, '.');                    // ? → .
  const regex = new RegExp(`^${regexPattern}$`, 'i');

  function walk(dir, depth) {
    if (depth > maxDepth || results.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', 'out']);
        if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(fullPath, depth + 1);
      } else {
        if (regex.test(entry.name)) {
          const relDir = path.relative(root, dir);
          results.push({
            name: entry.name,
            dir: relDir || '.',
            path: fullPath,
          });
        }
      }
    }
  }

  walk(root, 0);
  return results;
}

// ── Main Handler ────────────────────────────────────────────────────────

async function handleProjectCommand(subCommand, args = [], options = {}) {
  switch (subCommand) {
    case 'map':
    case 'm':
      return handleProjectMap(args, options);

    case 'analyze':
    case 'a':
    case 'analysis':
      return handleProjectAnalyze(args, options);

    case 'structure':
    case 'struct':
    case 's':
      return handleProjectStructure(args, options);

    case 'index':
    case 'i':
    case 'mini':
      return handleProjectIndex(args, options);

    case 'scan':
    case 'find':
    case 'search':
      return handleProjectScan(args, options);

    case 'help':
    case 'h':
    case '?':
      return _printHelp();

    default:
      // Default: if no subcommand, treat as analyze with the full input
      if (subCommand) {
        // User typed something like "project 分析架构"
        const query = [subCommand, ...args].join(' ');
        return handleProjectAnalyze([query], options);
      }
      return _printHelp();
  }
}

module.exports = {
  handleProjectCommand,
  handleProjectMap,
  handleProjectAnalyze,
  handleProjectStructure,
  handleProjectIndex,
  handleProjectScan,
};
