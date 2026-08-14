'use strict';

const {
  ULTRAWORK_DIRECTIVE,
  CODING_DIRECTIVE,
  removeCodeBlocks,
  detectModes,
  applyIntentGate,
  getAcceptanceCriteria,
} = require('../../src/services/intentGate');

describe('intentGate', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('detects ultrawork keyword in plain text', () => {
    const result = detectModes('Please run this in ultrawork mode.');
    expect(result.ultrawork).toBe(true);
    expect(result.trigger).toBe('ultrawork');
    expect(result.modes).toContain('ultrawork');
  });

  test('detects ulw shorthand keyword', () => {
    const result = detectModes('Use ULW for this task.');
    expect(result.ultrawork).toBe(true);
    expect(result.trigger).toBe('ulw');
  });

  test('ignores keywords inside fenced code blocks', () => {
    const text = [
      'Please execute this snippet:',
      '```bash',
      'echo ultrawork',
      '```',
    ].join('\n');

    const result = detectModes(text);
    expect(result.ultrawork).toBe(false);
    expect(result.modes).toEqual([]);
  });

  test('removeCodeBlocks strips fenced blocks for intent detection', () => {
    const cleaned = removeCodeBlocks('abc\n```txt\nultrawork\n```\nxyz');
    expect(cleaned).toContain('abc');
    expect(cleaned).toContain('xyz');
    expect(cleaned).not.toContain('ultrawork');
  });

  test('applyIntentGate returns systemDirective when activated', () => {
    const result = applyIntentGate('ultrawork fix the issue');
    expect(result.activatedModes).toEqual(['ultrawork']);
    expect(result.directives.length).toBe(1);
    expect(result.systemDirective).toContain(ULTRAWORK_DIRECTIVE);
    expect(result.message).toBe('ultrawork fix the issue');
  });

  test('applyIntentGate keeps message unchanged when no mode matches', () => {
    const input = 'Please help me inspect this bug.';
    const result = applyIntentGate(input);
    expect(result.activatedModes).toEqual([]);
    expect(result.directives).toEqual([]);
    expect(result.message).toBe(input);
  });

  test('applyIntentGate attaches ultrawork chat override from environment', () => {
    process.env.KHY_ULTRAWORK_PREFERRED_MODEL = 'claude-4-opus';
    process.env.KHY_ULTRAWORK_PREFERRED_ADAPTER = 'relay';
    process.env.KHY_ULTRAWORK_PREFERRED_STRICT = 'true';
    const result = applyIntentGate('ultrawork do this now');
    expect(result.chatOptsPatch).toEqual({
      preferredModel: 'claude-4-opus',
      preferredAdapter: 'relay',
      preferredStrict: true,
      strictPreferred: true,
      _intentToolChoice: 'required',
    });
  });

  // ── Expanded CODING_TRIGGER_RE tests ──────────────────────────────

  describe('coding mode triggers', () => {
    test('detects SSM project in Chinese', () => {
      const result = detectModes('创建一个SSM项目');
      expect(result.coding).toBe(true);
    });

    test('detects React project creation', () => {
      const result = detectModes('create a React app with TypeScript');
      expect(result.coding).toBe(true);
    });

    test('detects Vue project in Chinese', () => {
      const result = detectModes('搭建一个Vue前端项目');
      expect(result.coding).toBe(true);
    });

    test('detects Flask project creation', () => {
      const result = detectModes('build a Flask REST API server');
      expect(result.coding).toBe(true);
    });

    test('detects Rust cargo new', () => {
      const result = detectModes('cargo new my-cli-tool');
      expect(result.coding).toBe(true);
    });

    test('detects Go module init', () => {
      const result = detectModes('go mod init github.com/user/project');
      expect(result.coding).toBe(true);
    });

    test('detects full-stack project', () => {
      const result = detectModes('build a full-stack CRUD app');
      expect(result.coding).toBe(true);
    });

    test('detects Django project', () => {
      const result = detectModes('写一个Django后端服务');
      expect(result.coding).toBe(true);
    });

    test('detects Express API', () => {
      const result = detectModes('create project with Express and MongoDB');
      expect(result.coding).toBe(true);
    });

    test('detects Next.js', () => {
      const result = detectModes('setup a new Next.js project');
      expect(result.coding).toBe(true);
    });

    test('does not trigger on simple greeting', () => {
      const result = detectModes('你好');
      expect(result.coding).toBe(false);
    });

    test('does not trigger on unrelated question', () => {
      const result = detectModes('what is the meaning of life?');
      expect(result.coding).toBe(false);
    });

    test('detects NestJS', () => {
      const result = detectModes('create a NestJS microservice');
      expect(result.coding).toBe(true);
    });

    test('detects Electron app', () => {
      const result = detectModes('build an Electron desktop app');
      expect(result.coding).toBe(true);
    });

    test('detects Chinese "做一个网站"', () => {
      const result = detectModes('做一个个人博客网站');
      expect(result.coding).toBe(true);
    });

    test('detects Chinese "帮我写后端"', () => {
      const result = detectModes('帮我写一个用户管理后端');
      expect(result.coding).toBe(true);
    });

    test('detects "开发一个后端服务"', () => {
      const result = detectModes('开发一个后端服务');
      expect(result.coding).toBe(true);
    });

    test('detects 小程序 (mini program)', () => {
      const result = detectModes('开发一个微信小程序');
      expect(result.coding).toBe(true);
    });

    test('detects Gin (Go framework)', () => {
      const result = detectModes('create a Gin REST API');
      expect(result.coding).toBe(true);
    });

    test('detects Tauri desktop app', () => {
      const result = detectModes('build a Tauri app');
      expect(result.coding).toBe(true);
    });
  });

  // ── CODING_DIRECTIVE content tests ────────────────────────────────

  describe('CODING_DIRECTIVE content', () => {
    test('includes environment check instruction', () => {
      expect(CODING_DIRECTIVE).toContain('check required tools exist');
    });

    test('includes proactive installation instruction', () => {
      expect(CODING_DIRECTIVE).toContain('install it proactively');
    });

    test('includes layered architecture instruction', () => {
      expect(CODING_DIRECTIVE).toContain('controller/service/model/config');
      expect(CODING_DIRECTIVE).toContain('components/pages/hooks/utils');
    });

    test('includes Dockerfile instruction', () => {
      expect(CODING_DIRECTIVE).toContain('Dockerfile');
      expect(CODING_DIRECTIVE).toContain('multi-stage build');
    });

    test('includes docker-compose instruction', () => {
      expect(CODING_DIRECTIVE).toContain('docker-compose.yml');
      expect(CODING_DIRECTIVE).toContain('docker compose up');
    });

    test('includes .dockerignore instruction', () => {
      expect(CODING_DIRECTIVE).toContain('.dockerignore');
    });

    test('includes unit_tests instruction', () => {
      expect(CODING_DIRECTIVE).toContain('unit_tests/');
    });

    test('includes API_tests instruction', () => {
      expect(CODING_DIRECTIVE).toContain('API_tests/');
    });

    test('includes run_tests.sh instruction', () => {
      expect(CODING_DIRECTIVE).toContain('run_tests.sh');
    });

    test('includes README instruction', () => {
      expect(CODING_DIRECTIVE).toContain('README.md');
    });

    test('includes structured JSON response instruction', () => {
      expect(CODING_DIRECTIVE).toContain('structured JSON format');
      expect(CODING_DIRECTIVE).toContain('{code, msg, data}');
    });

    test('includes input validation instruction', () => {
      expect(CODING_DIRECTIVE).toContain('input validation');
      expect(CODING_DIRECTIVE).toContain('SQL injection');
    });

    test('includes logging instruction', () => {
      expect(CODING_DIRECTIVE).toContain('logging');
    });

    test('includes UI framework instruction', () => {
      expect(CODING_DIRECTIVE).toContain('UI framework');
      expect(CODING_DIRECTIVE).toContain('loading states');
    });

    test('forbids hardcoded mock data', () => {
      expect(CODING_DIRECTIVE).toContain('NEVER use hardcoded mock data');
    });

    test('includes summary instruction', () => {
      expect(CODING_DIRECTIVE).toContain('summarize');
    });

    test('includes Post-Completion Gate notice', () => {
      expect(CODING_DIRECTIVE).toContain('Post-Completion Gate');
      expect(CODING_DIRECTIVE).toContain('automatically verify');
    });
  });

  // ── getAcceptanceCriteria tests ──────────────────────────────────

  describe('getAcceptanceCriteria', () => {
    test('returns coding criteria for coding mode', () => {
      const criteria = getAcceptanceCriteria(['coding']);
      expect(criteria.length).toBeGreaterThan(0);
      // The always-required coding core. Dockerfile/readme criteria are now
      // signal-gated (scaffold/container) and surface via buildAcceptancePack,
      // not the static MODE_ACCEPTANCE.coding list.
      expect(criteria.some(c => c.id === 'workspace_change_evidence')).toBe(true);
      expect(criteria.some(c => c.id === 'delivery_evidence')).toBe(true);
    });

    test('returns empty array for empty modes', () => {
      const criteria = getAcceptanceCriteria([]);
      expect(criteria).toEqual([]);
    });

    test('returns combined criteria for multiple modes', () => {
      const criteria = getAcceptanceCriteria(['coding', 'ultrawork']);
      const codingOnly = getAcceptanceCriteria(['coding']);
      const ultraworkOnly = getAcceptanceCriteria(['ultrawork']);
      expect(criteria.length).toBe(codingOnly.length + ultraworkOnly.length);
    });

    test('handles unknown modes gracefully', () => {
      const criteria = getAcceptanceCriteria(['nonexistent']);
      expect(criteria).toEqual([]);
    });
  });
});
