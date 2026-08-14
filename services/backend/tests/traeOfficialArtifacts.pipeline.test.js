'use strict';

/**
 * Trae artifact 提取链路 + getStatus 状态结构测试
 */

const {
  extractTraeOfficialArtifactsFromStorage,
  resolveTraeOfficialCredential,
  decodeTraeOfficialAuthBlob,
  TRAE_NATIVE_API_PATHS,
} = require('../src/services/gateway/adapters/traeOfficialArtifacts');

// ── 辅助 ─────────────────────────────────────────────

function makeTraeBlob(totalLen = 200) {
  const buf = Buffer.alloc(totalLen);
  buf[0] = 0x74; buf[1] = 0x63; buf[2] = 0x05; buf[3] = 0x10; buf[4] = 0x00; buf[5] = 0x00;
  for (let i = 6; i < totalLen; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf.toString('base64');
}

function makeMockStorage({ withAuthBlob = false, withUsertag = false, withServerData = false, withPlainToken = false } = {}) {
  const data = {};
  if (withAuthBlob) data['iCubeAuthInfo://icube.cloudide'] = makeTraeBlob();
  if (withUsertag) data['iCubeAuthInfo://usertag'] = makeTraeBlob();
  if (withServerData) {
    data['iCubeServerData://icube.cloudide'] = JSON.stringify({
      entitlementInfo: { plan: 'pro' },
      region: 'cn-east',
      userId: 'user-abc',
    });
  }
  if (withPlainToken) {
    data['traeAuth.accessToken'] = JSON.stringify({
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.test_token_long_enough_to_pass_validation.sig',
    });
  }
  return data;
}

// ── extractTraeOfficialArtifactsFromStorage 测试 ──────

describe('extractTraeOfficialArtifactsFromStorage', () => {
  test('空 storage 返回空 artifact', () => {
    const r = extractTraeOfficialArtifactsFromStorage({}, '/mock/empty.json');
    expect(r.officialArtifactsDetected).toBe(false);
    expect(r.authBlobPresent).toBe(false);
    expect(r.credentialMode).toBe('none');
  });

  test('含加密 authBlob 返回 encrypted 模式', () => {
    const data = makeMockStorage({ withAuthBlob: true });
    const r = extractTraeOfficialArtifactsFromStorage(data, '/mock/storage.json');

    expect(r.officialArtifactsDetected).toBe(true);
    expect(r.authBlobPresent).toBe(true);
    expect(r.authBlobRaw).toBeTruthy();
    expect(r.credentialMode).toBe('encrypted');
    expect(r.plainTextToken).toBeNull();
  });

  test('含加密 authBlob + usertag + serverData 全部检出', () => {
    const data = makeMockStorage({ withAuthBlob: true, withUsertag: true, withServerData: true });
    const r = extractTraeOfficialArtifactsFromStorage(data, '/mock/storage.json');

    expect(r.officialArtifactsDetected).toBe(true);
    expect(r.authBlobPresent).toBe(true);
    expect(r.userTagBlobPresent).toBe(true);
    expect(r.serverDataPresent).toBe(true);
    expect(r.regionHint).toBe('cn-east');
    expect(r.userIdHint).toBe('user-abc');
    expect(r.credentialMode).toBe('encrypted');
  });

  test('serverData 无 apiHost 时 endpointHints 为空', () => {
    const data = makeMockStorage({ withServerData: true });
    const r = extractTraeOfficialArtifactsFromStorage(data, '/mock/storage.json');

    expect(r.serverDataPresent).toBe(true);
    // entitlementInfo 里没有 URL，所以不应有 endpoint hints
    expect(r.endpointHints.length).toBe(0);
  });

  test('serverData 含嵌套 trae.ai URL 被提取', () => {
    const data = {
      'iCubeServerData://icube.cloudide': JSON.stringify({
        entitlementInfo: { plan: 'pro' },
        nested: { deep: { url: 'https://grow-normal.trae.ai/some/path' } },
      }),
    };
    const r = extractTraeOfficialArtifactsFromStorage(data, '/mock/storage.json');

    expect(r.serverDataPresent).toBe(true);
    expect(r.endpointHints).toContain('https://grow-normal.trae.ai/some/path');
  });

  test('null data 不崩溃', () => {
    const r = extractTraeOfficialArtifactsFromStorage(null, '/mock/null.json');
    expect(r.officialArtifactsDetected).toBe(false);
  });

  test('traeAuth key 含明文 token', () => {
    const data = { 'traeAuth.accessToken': 'eyJhbGciOiJIUzI1NiJ9.payload.signature_here_long' };
    const r = extractTraeOfficialArtifactsFromStorage(data, '/mock/storage.json');

    expect(r.officialArtifactsDetected).toBe(true);
    expect(r.plainTextToken).toBeTruthy();
    expect(r.credentialMode).toBe('plaintext');
  });
});

// ── resolveTraeOfficialCredential 测试 ────────────────

describe('resolveTraeOfficialCredential', () => {
  test('仅加密 blob → credentialMode=encrypted, token=null', () => {
    const data = makeMockStorage({ withAuthBlob: true, withServerData: true });
    const artifacts = extractTraeOfficialArtifactsFromStorage(data, '/mock');
    const cred = resolveTraeOfficialCredential({ artifacts });

    expect(cred.source).toBe('official-trae');
    expect(cred.officialArtifactsDetected).toBe(true);
    expect(cred.credentialMode).toBe('encrypted');
    expect(cred.token).toBeNull();
    expect(cred.authBlobPresent).toBe(true);
    expect(cred.authBlobAnalysis).toBeTruthy();
    expect(cred.authBlobAnalysis.schemeHint).toBe('trae-custom-encrypted');
    expect(cred.authBlobAnalysis.encryptionService).toBe('electron-safeStorage');
  });

  test('空 artifact → credentialMode=none', () => {
    const artifacts = extractTraeOfficialArtifactsFromStorage({}, '/mock');
    const cred = resolveTraeOfficialCredential({ artifacts });

    expect(cred.officialArtifactsDetected).toBe(false);
    expect(cred.credentialMode).toBe('none');
    expect(cred.token).toBeNull();
    expect(cred.authBlobAnalysis).toBeNull();
  });

  test('blob 内含 JWT → 解出 token + plaintext', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const data = {
      'iCubeAuthInfo://icube.cloudide': jwt,
    };
    const artifacts = extractTraeOfficialArtifactsFromStorage(data, '/mock');
    const cred = resolveTraeOfficialCredential({ artifacts });

    // JWT 通过 decodeTraeOfficialAuthBlob 的 JWT 检测分支
    // 但 extractTraeOfficialArtifactsFromStorage 保存的是 authBlobRaw
    // resolveTraeOfficialCredential 会调用 decodeTraeOfficialAuthBlob
    expect(cred.credentialMode).toBe('plaintext');
    expect(cred.token).toBe(jwt);
  });

  test('含 serverData regionHint 传递', () => {
    const data = makeMockStorage({ withAuthBlob: true, withServerData: true });
    const artifacts = extractTraeOfficialArtifactsFromStorage(data, '/mock');
    const cred = resolveTraeOfficialCredential({ artifacts });

    expect(cred.regionHint).toBe('cn-east');
    expect(cred.userIdHint).toBe('user-abc');
  });
});

// ── getStatus 状态结构测试 ────────────────────────────
// getStatus 依赖大量 module-level 状态，用 mock 方式验证结构

describe('getStatus 输出结构', () => {
  // 直接 require 会触发模块初始化，所以我们验证返回值的结构合规性
  // 而不是模拟所有内部状态

  let traeAdapter;

  beforeAll(() => {
    // Mock 外部依赖
    jest.mock('../src/services/gateway/adapters/ipAnonymizer', () => ({
      sanitizeOutgoingHeaders: (h) => h,
    }));
    jest.mock('../src/services/gateway/adapters/_imageCompat', () => ({
      attachImagesToOpenAIMessages: (m) => m,
    }));
    jest.mock('../src/services/gateway/adapters/_proxyTunnel', () => ({
      requestJson: jest.fn().mockRejectedValue(new Error('no network')),
      collectProxyCandidates: () => [],
    }));

    traeAdapter = require('../src/services/gateway/adapters/traeAdapter');
  });

  afterAll(() => {
    if (traeAdapter && typeof traeAdapter.destroy === 'function') {
      traeAdapter.destroy();
    }
  });

  test('getStatus 返回必需字段', () => {
    const status = traeAdapter.getStatus();

    // 顶层必需字段
    expect(status).toHaveProperty('name');
    expect(status).toHaveProperty('type', 'trae');
    expect(status).toHaveProperty('available');
    expect(status).toHaveProperty('statusLevel');
    expect(status).toHaveProperty('detail');
    expect(status).toHaveProperty('installDetected');
    expect(status).toHaveProperty('officialArtifactsDetected');
    expect(status).toHaveProperty('officialArtifactSources');
    expect(status).toHaveProperty('credentialMode');
    expect(status).toHaveProperty('sessionVerified');

    // statusLevel 必须是五级之一
    expect(['verified', 'pending', 'encrypted', 'installed', 'missing']).toContain(status.statusLevel);
  });

  test('getStatus 返回端点状态数组', () => {
    const status = traeAdapter.getStatus();

    expect(status).toHaveProperty('endpoints');
    expect(Array.isArray(status.endpoints)).toBe(true);
    // 每个端点都有 endpoint + status 字段
    for (const ep of status.endpoints) {
      expect(ep).toHaveProperty('endpoint');
      expect(ep).toHaveProperty('status');
      expect(['ok', 'fail', 'untested']).toContain(ep.status);
    }
  });

  test('getStatus 返回 SDK 信息', () => {
    const status = traeAdapter.getStatus();

    expect(status).toHaveProperty('sdk');
    expect(status.sdk).toHaveProperty('available');
    expect(status.sdk).toHaveProperty('mode');
    expect(typeof status.sdk.available).toBe('boolean');
  });

  test('getStatus 返回模型发现信息', () => {
    const status = traeAdapter.getStatus();

    expect(status).toHaveProperty('officialModels');
    expect(status.officialModels).toHaveProperty('hit');
    expect(status.officialModels).toHaveProperty('mergedCount');
    expect(typeof status.officialModels.hit).toBe('boolean');
  });

  test('getStatus officialArtifacts 结构（有或 null）', () => {
    const status = traeAdapter.getStatus();

    // officialArtifacts 可能是 null（无官方凭据）或对象
    if (status.officialArtifacts !== null) {
      expect(status.officialArtifacts).toHaveProperty('detected');
      expect(status.officialArtifacts).toHaveProperty('sources');
      expect(status.officialArtifacts).toHaveProperty('credentialMode');
    }
  });

  test('无 token 时 statusLevel 为 installed 或 missing', () => {
    // 在测试环境（Linux CI）下通常没有 Trae 安装
    const status = traeAdapter.getStatus();

    if (!status.available) {
      expect(['encrypted', 'installed', 'missing']).toContain(status.statusLevel);
      expect(status.sessionVerified).toBe(false);
    }
  });

  test('detail 是中文字符串', () => {
    const status = traeAdapter.getStatus();
    expect(typeof status.detail).toBe('string');
    expect(status.detail.length).toBeGreaterThan(0);
  });
});
