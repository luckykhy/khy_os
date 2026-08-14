import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the axios client and authedFetch so the composable can be tested in
// isolation (no real network, no pinia store bootstrapping).
vi.mock('@/api/request', () => {
  const request = {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    defaults: { baseURL: '' },
  };
  return { default: request };
});
vi.mock('@/api/authedFetch', () => ({ authedFetch: vi.fn() }));

import request from '@/api/request';
import { authedFetch } from '@/api/authedFetch';
import { useWxBinding, parseSseFrame } from './useWxBinding';

// Build a fake fetch Response whose body streams the given SSE frame strings.
function fakeSseResponse(frames) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (i < frames.length) {
              return Promise.resolve({ value: encoder.encode(frames[i++]), done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  };
}

// A response that never ends until aborted — lets us assert cancel isolation.
function fakePendingResponse() {
  const encoder = new TextEncoder();
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (!sent) {
              sent = true;
              // Emit the session frame first, then hang.
              return Promise.resolve({
                value: encoder.encode('event: session\ndata: {"sessionId":"never-ends"}\n\n'),
                done: false,
              });
            }
            return new Promise(() => {}); // hang forever
          },
        };
      },
    },
  };
}

// A 429 over-limit response with { error } body.
function fake429Response(errorText) {
  return {
    ok: false,
    status: 429,
    json: () => Promise.resolve({ error: errorText }),
  };
}

describe('parseSseFrame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses an event + json data frame (space after colon)', () => {
    const frame = 'event: qr\ndata: {"attempt":1,"qrcodeUrl":"u","dataUrl":"d"}';
    expect(parseSseFrame(frame)).toEqual({
      event: 'qr',
      data: { attempt: 1, qrcodeUrl: 'u', dataUrl: 'd' },
    });
  });

  it('parses the session first frame carrying sessionId', () => {
    expect(parseSseFrame('event: session\ndata: {"sessionId":"abc-123"}')).toEqual({
      event: 'session',
      data: { sessionId: 'abc-123' },
    });
  });

  it('parses the terminal done frame with empty data', () => {
    expect(parseSseFrame('event: done\ndata: {}')).toEqual({ event: 'done', data: {} });
  });

  it('parses a status message frame', () => {
    expect(parseSseFrame('event: status\ndata: {"message":"等待确认"}')).toEqual({
      event: 'status',
      data: { message: '等待确认' },
    });
  });

  it('returns null for keepalive comment frames', () => {
    expect(parseSseFrame(': keepalive')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
  });

  it('yields null data on malformed json (fail-soft)', () => {
    expect(parseSseFrame('event: error\ndata: {not json')).toEqual({ event: 'error', data: null });
  });
});

describe('useWxBinding REST shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchAccounts maps accounts + daemonRunning from a bare payload', async () => {
    request.get.mockResolvedValue({
      data: {
        accounts: [
          {
            accountId: 'a1',
            userId: 'u1',
            token: '***',
            active: true,
            expired: false,
            heartbeatAgeMs: 1200,
          },
        ],
        daemonRunning: true,
      },
    });
    const wx = useWxBinding();
    const res = await wx.fetchAccounts();
    expect(request.get).toHaveBeenCalledWith('/api/wx/accounts');
    expect(wx.accounts.value).toHaveLength(1);
    expect(wx.accounts.value[0].accountId).toBe('a1');
    expect(wx.daemonRunning.value).toBe(true);
    expect(res.daemonRunning).toBe(true);
    expect(wx.loading.value).toBe(false);
  });

  it('bind posts {accountId, workspace, agent} and omits empty agent', async () => {
    request.post.mockResolvedValue({
      data: { ok: true, accountId: 'a1', binding: { workspace: 'w', agent: '' } },
    });
    const wx = useWxBinding();

    await wx.bind({ accountId: 'a1', workspace: 'w', agent: 'g' });
    expect(request.post).toHaveBeenCalledWith('/api/wx/bind', {
      accountId: 'a1',
      workspace: 'w',
      agent: 'g',
    });

    await wx.bind({ accountId: 'a1', workspace: 'w', agent: '' });
    expect(request.post).toHaveBeenLastCalledWith('/api/wx/bind', {
      accountId: 'a1',
      workspace: 'w',
    });
  });

  it('unbindRoute / removeAccount hit the right encoded DELETE routes', async () => {
    request.delete.mockResolvedValue({ data: { ok: true, accountId: 'a 1' } });
    const wx = useWxBinding();
    await wx.unbindRoute('a 1');
    expect(request.delete).toHaveBeenCalledWith('/api/wx/bind/a%201');
    await wx.removeAccount('a 1');
    expect(request.delete).toHaveBeenLastCalledWith('/api/wx/accounts/a%201');
  });

  it('setActive posts {accountId}', async () => {
    request.post.mockResolvedValue({ data: { ok: true, accountId: 'a1' } });
    const wx = useWxBinding();
    await wx.setActive('a1');
    expect(request.post).toHaveBeenCalledWith('/api/wx/active', { accountId: 'a1' });
  });
});

describe('useWxBinding multi-session login stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses session first frame + qr + confirmed: sets sessionId/qr, marks success, refreshes accounts', async () => {
    request.get.mockResolvedValue({ data: { accounts: [], daemonRunning: true } });
    authedFetch.mockResolvedValue(
      fakeSseResponse([
        'event: session\ndata: {"sessionId":"sid-1"}\n\n',
        'event: qr\ndata: {"attempt":1,"qrcodeUrl":"u","dataUrl":"d"}\n\n',
        'event: status\ndata: {"message":"\u7b49\u5f85\u786e\u8ba4"}\n\n',
        'event: confirmed\ndata: {"account":{"accountId":"a1","userId":"u1","preview":"p"},"isNew":true,"firstBoundAt":"2026-08-05T10:00:00.000Z"}\n\n',
        'event: daemon\ndata: {"ok":true,"restarted":true}\n\n',
        'event: done\ndata: {}\n\n',
      ])
    );
    const wx = useWxBinding();
    let confirmed = null;
    const item = wx.startLoginSession({
      onSuccess: (_it, acc) => {
        confirmed = acc;
      },
    });
    await item._promise;

    expect(authedFetch).toHaveBeenCalledWith(
      '/api/wx/login/stream',
      expect.objectContaining({ stream: true })
    );
    expect(item.sessionId).toBe('sid-1');
    expect(item.qr.attempt).toBe(1);
    expect(item.qr.dataUrl).toBe('d');
    expect(item.qr.qrcodeUrl).toBe('u');
    expect(item.status).toBe('success');
    expect(item.success).toBe(true);
    // isNew=true → fresh bind, not a re-bind.
    expect(item.isNew).toBe(true);
    expect(item.firstBoundAt).toBe('2026-08-05T10:00:00.000Z');
    expect(item.rebound).toBe(false);
    expect(confirmed).toEqual({ accountId: 'a1', userId: 'u1', preview: 'p' });
    // confirmed triggers an account list refresh via the REST endpoint
    expect(request.get).toHaveBeenCalledWith('/api/wx/accounts');
  });

  it('confirmed with isNew=false marks the card as a re-bind (refreshed login) and keeps firstBoundAt', async () => {
    request.get.mockResolvedValue({ data: { accounts: [], daemonRunning: true } });
    authedFetch.mockResolvedValue(
      fakeSseResponse([
        'event: session\ndata: {"sessionId":"sid-2"}\n\n',
        'event: qr\ndata: {"attempt":1,"qrcodeUrl":"u","dataUrl":"d"}\n\n',
        'event: confirmed\ndata: {"account":{"accountId":"a2","userId":"u2","preview":"p2"},"isNew":false,"firstBoundAt":"2026-01-02T03:04:05.000Z"}\n\n',
        'event: done\ndata: {}\n\n',
      ])
    );
    const wx = useWxBinding();
    const item = wx.startLoginSession();
    await item._promise;

    expect(item.status).toBe('success');
    expect(item.success).toBe(true);
    // isNew=false → previously bound WeChat; card flagged as rebound.
    expect(item.isNew).toBe(false);
    expect(item.rebound).toBe(true);
    expect(item.firstBoundAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('runs multiple concurrent sessions independently (distinct sessionId/qr per card)', async () => {
    authedFetch
      .mockResolvedValueOnce(
        fakeSseResponse([
          'event: session\ndata: {"sessionId":"sid-A"}\n\n',
          'event: qr\ndata: {"attempt":1,"qrcodeUrl":"uA","dataUrl":"dA"}\n\n',
          'event: done\ndata: {}\n\n',
        ])
      )
      .mockResolvedValueOnce(
        fakeSseResponse([
          'event: session\ndata: {"sessionId":"sid-B"}\n\n',
          'event: qr\ndata: {"attempt":2,"qrcodeUrl":"uB","dataUrl":"dB"}\n\n',
          'event: done\ndata: {}\n\n',
        ])
      );
    const wx = useWxBinding();
    const a = wx.startLoginSession();
    const b = wx.startLoginSession();
    await Promise.all([a._promise, b._promise]);

    expect(wx.sessions.value).toHaveLength(2);
    expect(a.sessionId).toBe('sid-A');
    expect(a.qr.qrcodeUrl).toBe('uA');
    expect(b.sessionId).toBe('sid-B');
    expect(b.qr.qrcodeUrl).toBe('uB');
    // The two streams never cross-contaminate each other.
    expect(a.qr.dataUrl).toBe('dA');
    expect(b.qr.dataUrl).toBe('dB');
  });

  it('cancelLoginSession aborts + posts the right sessionId and only removes that card', async () => {
    authedFetch.mockResolvedValue(fakePendingResponse());
    request.post.mockResolvedValue({ data: { ok: true, cancelled: true } });
    const wx = useWxBinding();

    const a = wx.startLoginSession();
    const b = wx.startLoginSession();
    // Let the session frames resolve so each card knows its sessionId.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(wx.sessions.value).toHaveLength(2);
    expect(a.sessionId).toBe('never-ends');

    await wx.cancelLoginSession(a);

    // Only the cancelled card is removed; the other keeps streaming.
    expect(wx.sessions.value).toHaveLength(1);
    expect(wx.sessions.value[0]).toBe(b);
    // Backend cancel carries the specific sessionId of the cancelled card.
    expect(request.post).toHaveBeenCalledWith(
      '/api/wx/login/cancel',
      { sessionId: 'never-ends' },
      { silent: true }
    );
  });

  it('cancelLoginSession without a sessionId does a local-only close (no HTTP cancel)', async () => {
    // A card cancelled before its SSE session frame arrives has no sessionId; the
    // backend has no matching session yet, so POST /login/cancel would 400 and be
    // meaningless. It must only close locally and skip the HTTP call.
    authedFetch.mockResolvedValue(fakePendingResponse());
    request.post.mockResolvedValue({ data: { ok: true } });
    const wx = useWxBinding();

    const item = wx.startLoginSession();
    // Do NOT let the session frame resolve — sessionId stays null.
    expect(item.sessionId).toBeNull();
    expect(wx.sessions.value).toHaveLength(1);

    await wx.cancelLoginSession(item);

    // Card is removed locally, but no backend cancel is fired without a sessionId.
    expect(wx.sessions.value).toHaveLength(0);
    expect(request.post).not.toHaveBeenCalled();
  });

  it('surfaces HTTP 429 over-limit error on the card and stops that stream', async () => {
    authedFetch.mockResolvedValue(fake429Response('扫码绑定并发已达上限，请稍后再试'));
    const wx = useWxBinding();
    let errMsg = '';
    const item = wx.startLoginSession({
      onError: (_it, err) => {
        errMsg = err.message;
      },
    });
    await item._promise;

    expect(item.status).toBe('error');
    expect(item.error).toBe('扫码绑定并发已达上限，请稍后再试');
    expect(item.statusText).toBe('扫码绑定并发已达上限，请稍后再试');
    expect(errMsg).toBe('扫码绑定并发已达上限，请稍后再试');
    // No qr was ever rendered for a rejected session.
    expect(item.qr.dataUrl).toBeNull();
  });

  it('reports error frames on the owning card', async () => {
    authedFetch.mockResolvedValue(
      fakeSseResponse([
        'event: session\ndata: {"sessionId":"sid-e"}\n\n',
        'event: error\ndata: {"message":"扫码超时"}\n\n',
        'event: done\ndata: {}\n\n',
      ])
    );
    const wx = useWxBinding();
    let errMsg = '';
    const item = wx.startLoginSession({
      onError: (_it, e) => {
        errMsg = e.message;
      },
    });
    await item._promise;
    expect(item.status).toBe('error');
    expect(item.error).toBe('扫码超时');
    expect(errMsg).toBe('扫码超时');
  });

  it('marks expired frames so the card can offer a retry', async () => {
    authedFetch.mockResolvedValue(
      fakeSseResponse([
        'event: session\ndata: {"sessionId":"sid-x"}\n\n',
        'event: expired\ndata: {}\n\n',
        'event: done\ndata: {}\n\n',
      ])
    );
    const wx = useWxBinding();
    const item = wx.startLoginSession();
    await item._promise;
    expect(item.status).toBe('expired');
    expect(item.statusText).toContain('过期');
  });
});
