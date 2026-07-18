'use strict';

/**
 * CLI-Anything Generator — 7-stage AI pipeline for generating agent-controllable CLIs.
 *
 * Orchestrates the full lifecycle:
 *   Stage 0: Source acquisition (git clone / local path)
 *   Stage 1: Codebase analysis (AI-driven SOP generation)
 *   Stage 2: Architecture design (command groups, state model, output format)
 *   Stage 3: Implementation (Python Click / Node.js Commander CLI code)
 *   Stage 4: Test planning (TEST.md Part 1)
 *   Stage 5: Test implementation (pytest / node:test)
 *   Stage 6: Documentation + SKILL.md generation
 *   Stage 7: Packaging + KHY OS registration
 *
 * Each stage saves its output to ~/.khy/cli-anything/generated/<SOFTWARE>/ and
 * updates a checkpoint file so the pipeline can be resumed after interruption.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { safeMklink } = require('../tools/platformUtils');

const BASE_DIR = path.join(os.homedir(), '.khy', 'cli-anything', 'generated');
const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'cliAnythingTemplates');

const STAGES = [
  { id: 0, name: 'acquire',   label: 'Source Acquisition',    template: 'STAGE_0_ACQUIRE.md' },
  { id: 1, name: 'analyze',   label: 'Codebase Analysis',     template: 'STAGE_1_ANALYZE.md' },
  { id: 2, name: 'design',    label: 'Architecture Design',   template: 'STAGE_2_DESIGN.md' },
  { id: 3, name: 'implement', label: 'Implementation',        template: 'STAGE_3_IMPLEMENT.md' },
  { id: 4, name: 'testplan',  label: 'Test Planning',         template: 'STAGE_4_TESTPLAN.md' },
  { id: 5, name: 'testcode',  label: 'Test Implementation',   template: 'STAGE_5_TESTCODE.md' },
  { id: 6, name: 'docs',      label: 'Documentation & SKILL', template: 'STAGE_6_DOCS.md' },
  { id: 7, name: 'package',   label: 'Packaging & Register',  template: 'STAGE_7_PACKAGE.md' },
];

// 收敛到 utils/ensureDirSync 单一真源(逐字节委托,调用点不变)
const _ensureDir = require('../utils/ensureDirSync');

function _readTemplate(name) {
  const filePath = path.join(TEMPLATES_DIR, name);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

// 收敛到 utils/readJsonFileSafe 单一真源(逐字节委托,调用点不变)
const _readJSON = require('../utils/readJsonFileSafe');

function _writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function _inferSoftwareName(repoOrPath) {
  const input = String(repoOrPath || '').trim();
  if (input.startsWith('http') || input.startsWith('git@')) {
    const lastSegment = input.split('/').pop().replace(/\.git$/, '');
    return lastSegment.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  }
  return path.basename(input).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

// ── Checkpoint Management ────────────────────────────────────────────────────

function _checkpointPath(software) {
  return path.join(BASE_DIR, software, 'checkpoint.json');
}

function getCheckpoint(software) {
  return _readJSON(_checkpointPath(software)) || {
    software,
    currentStage: 0,
    completedStages: [],
    startedAt: null,
    lastUpdated: null,
    runtime: null,
    repoOrPath: null,
  };
}

function _saveCheckpoint(software, checkpoint) {
  const dir = path.join(BASE_DIR, software);
  _ensureDir(dir);
  checkpoint.lastUpdated = new Date().toISOString();
  _writeJSON(_checkpointPath(software), checkpoint);
}

function _markStageComplete(software, stageId) {
  const cp = getCheckpoint(software);
  if (!cp.completedStages.includes(stageId)) {
    cp.completedStages.push(stageId);
  }
  cp.currentStage = stageId + 1;
  _saveCheckpoint(software, cp);
}

// ── Stage 0: Source Acquisition ──────────────────────────────────────────────

function executeStage0(repoOrPath, software, runtime) {
  const workDir = path.join(BASE_DIR, software);
  _ensureDir(workDir);

  const input = String(repoOrPath || '').trim();
  const isURL = input.startsWith('http') || input.startsWith('git@');
  const sourceDir = path.join(workDir, 'source');

  if (isURL) {
    if (!fs.existsSync(sourceDir)) {
      try {
        execSync(`git clone --depth 1 "${input}" "${sourceDir}"`, {
          stdio: 'pipe', timeout: 120000,
        });
      } catch (err) {
        return { success: false, error: `Git clone failed: ${err.message}` };
      }
    }
  } else {
    if (!fs.existsSync(input)) {
      return { success: false, error: `Path not found: ${input}` };
    }
    if (!fs.existsSync(sourceDir)) {
      // Cross-platform: junction/copy fallback avoids EPERM for non-admin Windows users.
      safeMklink(path.resolve(input), sourceDir);
    }
  }

  const result = {
    software,
    sourcePath: sourceDir,
    language: _detectLanguage(sourceDir),
    buildSystem: _detectBuildSystem(sourceDir),
    entryPoints: _detectEntryPoints(sourceDir),
    hasTests: _hasDir(sourceDir, 'tests') || _hasDir(sourceDir, 'test'),
    hasDocs: _hasDir(sourceDir, 'docs') || _hasDir(sourceDir, 'doc'),
  };

  _writeJSON(path.join(workDir, 'stage0_result.json'), result);

  const cp = getCheckpoint(software);
  cp.startedAt = cp.startedAt || new Date().toISOString();
  cp.runtime = runtime;
  cp.repoOrPath = repoOrPath;
  _saveCheckpoint(software, cp);
  _markStageComplete(software, 0);

  return { success: true, ...result };
}

function _detectLanguage(dir) {
  const indicators = [
    { files: ['setup.py', 'pyproject.toml', 'requirements.txt'], lang: 'python' },
    { files: ['package.json'], lang: 'javascript' },
    { files: ['Cargo.toml'], lang: 'rust' },
    { files: ['go.mod'], lang: 'go' },
    { files: ['CMakeLists.txt', 'Makefile'], lang: 'c/c++' },
    { files: ['pom.xml', 'build.gradle'], lang: 'java' },
  ];
  for (const ind of indicators) {
    for (const f of ind.files) {
      if (fs.existsSync(path.join(dir, f))) return ind.lang;
    }
  }
  return 'unknown';
}

function _detectBuildSystem(dir) {
  const checks = [
    ['CMakeLists.txt', 'cmake'], ['Makefile', 'make'], ['configure', 'autotools'],
    ['pyproject.toml', 'pyproject'], ['setup.py', 'setuptools'],
    ['package.json', 'npm'], ['Cargo.toml', 'cargo'], ['go.mod', 'go'],
  ];
  for (const [file, system] of checks) {
    if (fs.existsSync(path.join(dir, file))) return system;
  }
  return 'unknown';
}

function _detectEntryPoints(dir) {
  const entries = [];
  const candidates = ['main.py', 'cli.py', 'app.py', '__main__.py', 'index.js', 'cli.js', 'main.go', 'main.rs'];
  for (const f of candidates) {
    if (fs.existsSync(path.join(dir, f))) entries.push(f);
  }
  try {
    const pkgJson = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);
        entries.push(...bins);
      }
    }
  } catch { /* skip */ }
  try {
    const setupPy = path.join(dir, 'setup.py');
    if (fs.existsSync(setupPy)) {
      const content = fs.readFileSync(setupPy, 'utf-8');
      const match = content.match(/console_scripts.*?\[([^\]]+)\]/s);
      if (match) entries.push('(console_scripts found)');
    }
  } catch { /* skip */ }
  return entries;
}

function _hasDir(base, name) {
  try { return fs.statSync(path.join(base, name)).isDirectory(); } catch { return false; }
}

// ── AI Prompt Builder ────────────────────────────────────────────────────────

function buildStagePrompt(software, stageId, runtime) {
  const stage = STAGES[stageId];
  if (!stage) return null;

  const harness = _readTemplate('HARNESS_PROMPT.md') || '';
  const stageTemplate = _readTemplate(stage.template) || '';
  const workDir = path.join(BASE_DIR, software);
  const runtimeLabel = runtime === 'node' ? 'Node.js' : 'Python';

  let context = '';

  if (stageId === 0) {
    const cp = getCheckpoint(software);
    context = `\n## Context\n- Software: ${software}\n- Source: ${cp.repoOrPath || 'unknown'}\n- Runtime: ${runtimeLabel}\n- Working directory: ${workDir}\n`;
  } else if (stageId >= 1) {
    const prevResults = [];
    for (let i = 0; i < stageId; i++) {
      const resultFile = path.join(workDir, `stage${i}_result.json`);
      const data = _readJSON(resultFile);
      if (data) prevResults.push(`### Stage ${i} Output\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);
    }
    const sopFile = path.join(workDir, `${software}.md`);
    if (fs.existsSync(sopFile)) {
      prevResults.push(`### SOP Document\n${fs.readFileSync(sopFile, 'utf-8').slice(0, 4000)}`);
    }
    const archFile = path.join(workDir, 'architecture.json');
    const arch = _readJSON(archFile);
    if (arch) {
      prevResults.push(`### Architecture\n\`\`\`json\n${JSON.stringify(arch, null, 2).slice(0, 4000)}\n\`\`\``);
    }
    context = `\n## Previous Stage Results\n${prevResults.join('\n\n')}\n`;
  }

  const skeleton = runtime === 'node'
    ? _getNodeSkeletonSummary()
    : _getPythonSkeletonSummary();

  return [
    harness,
    `\n---\n# Stage ${stageId}: ${stage.label}\n`,
    stageTemplate,
    `\n## Runtime: ${runtimeLabel}\n`,
    `\n## Skeleton Reference\n${skeleton}\n`,
    context,
    `\n## Working Directory\n\`${workDir}\`\n`,
    `\nProceed with Stage ${stageId}. Save all output files to the working directory.`,
  ].join('\n');
}

function _getPythonSkeletonSummary() {
  return `Python CLI structure:
\`\`\`
cli_anything/<SOFTWARE>/
├── __init__.py, __main__.py
├── <SOFTWARE>_cli.py    (Click CLI)
├── core/project.py, session.py, export.py
├── utils/backend.py (find_exe + subprocess)
├── skills/SKILL.md
└── tests/
\`\`\`
Key: Use Click, namespace package, --json on every command, backend.py wraps real software via subprocess.`;
}

function _getNodeSkeletonSummary() {
  return `Node.js CLI structure:
\`\`\`
khy-cli-<SOFTWARE>/
├── openclaw.plugin.json
├── package.json
├── src/index.js         (Commander CLI)
├── src/core/project.js, session.js, export.js
├── src/backend.js       (findExe + child_process)
├── skills/manifest.json + prompt.md
└── tests/
\`\`\`
Key: Use Commander, openclaw.plugin.json for KHY, --json on every command, backend.js wraps real software via execFileSync.`;
}

// ── Pipeline Orchestration ───────────────────────────────────────────────────

function startPipeline(repoOrPath, options = {}) {
  const software = options.name || _inferSoftwareName(repoOrPath);
  const runtime = options.runtime || 'python';
  const workDir = path.join(BASE_DIR, software);
  _ensureDir(workDir);

  const cp = getCheckpoint(software);
  cp.startedAt = cp.startedAt || new Date().toISOString();
  cp.runtime = runtime;
  cp.repoOrPath = repoOrPath;
  _saveCheckpoint(software, cp);

  return {
    software,
    runtime,
    workDir,
    checkpoint: cp,
    totalStages: STAGES.length,
  };
}

function getStageInfo(stageId) {
  return STAGES[stageId] || null;
}

function getPipelineStatus(software) {
  const cp = getCheckpoint(software);
  const workDir = path.join(BASE_DIR, software);
  const exists = fs.existsSync(workDir);

  return {
    exists,
    software,
    ...cp,
    totalStages: STAGES.length,
    stages: STAGES.map(s => ({
      ...s,
      completed: cp.completedStages.includes(s.id),
      current: s.id === cp.currentStage,
    })),
  };
}

function listPipelines() {
  _ensureDir(BASE_DIR);
  const dirs = fs.readdirSync(BASE_DIR).filter(d => {
    try { return fs.statSync(path.join(BASE_DIR, d)).isDirectory(); } catch { return false; }
  });
  return dirs.map(d => getPipelineStatus(d));
}

function scaffoldFromSkeleton(software, runtime) {
  const workDir = path.join(BASE_DIR, software);
  _ensureDir(workDir);

  const skeletonDir = runtime === 'node'
    ? path.join(TEMPLATES_DIR, 'node_skeleton')
    : path.join(TEMPLATES_DIR, 'python_skeleton');

  if (!fs.existsSync(skeletonDir)) {
    return { success: false, error: `Skeleton directory not found: ${skeletonDir}` };
  }

  const files = fs.readdirSync(skeletonDir);
  const copied = [];

  for (const file of files) {
    const src = path.join(skeletonDir, file);
    const content = fs.readFileSync(src, 'utf-8');
    const expanded = content.replace(/\{\{SOFTWARE\}\}/g, software);

    let destName = file;
    if (file === 'cli_template.py') destName = `${software}_cli.py`;

    const dest = path.join(workDir, destName);
    fs.writeFileSync(dest, expanded);
    copied.push(destName);
  }

  return { success: true, workDir, files: copied };
}

function buildFullAIPrompt(repoOrPath, options = {}) {
  const software = options.name || _inferSoftwareName(repoOrPath);
  const runtime = options.runtime || 'python';
  const workDir = path.join(BASE_DIR, software);

  const harness = _readTemplate('HARNESS_PROMPT.md') || '';
  const stageSections = STAGES.map(s => {
    const tmpl = _readTemplate(s.template) || '';
    return `---\n# Stage ${s.id}: ${s.label}\n${tmpl}`;
  }).join('\n\n');

  const skeleton = runtime === 'node'
    ? _getNodeSkeletonSummary()
    : _getPythonSkeletonSummary();

  return [
    harness,
    `\n## Target Software\n- Source: \`${repoOrPath}\`\n- Name: \`${software}\`\n- Runtime: ${runtime === 'node' ? 'Node.js' : 'Python'}\n- Output: \`${workDir}\`\n`,
    `## Skeleton Reference\n${skeleton}\n`,
    stageSections,
    `\n---\n\nExecute all 8 stages sequentially. For each stage, save outputs to \`${workDir}/\`.`,
    `After Stage 7 (packaging), run \`khy app cli-sync\` to register the new CLI in KHY OS.`,
  ].join('\n\n');
}

module.exports = {
  STAGES,
  BASE_DIR,
  startPipeline,
  executeStage0,
  buildStagePrompt,
  buildFullAIPrompt,
  getCheckpoint,
  getStageInfo,
  getPipelineStatus,
  listPipelines,
  scaffoldFromSkeleton,
  // Detection helpers reused by khyAnythingProxy for instant onboarding.
  _detectLanguage,
  _detectBuildSystem,
  _detectEntryPoints,
};
