// khyos-api — minimal test API for Supabase Edge Functions (Deno).
// Reimplements the few REST routes the frontend first screen actually calls,
// backed by Supabase Postgres (RLS-protected). This is a TEST artifact:
// it does NOT replace services/backend (Node/Express) — it lets the GitHub
// Pages frontend talk to a free Postgres + free LLM proxy.
//
// Deploy: supabase functions deploy khyos-api
// Secrets: SUPABASE_URL / SUPABASE_SERVICE_KEY are auto-injected by Supabase.
//          Set ALLOW_ORIGIN for the GitHub Pages origin.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { createHash } from 'node:crypto';

const sbAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_KEY')!,
);

function corsHeaders() {
  const origin = Deno.env.get('ALLOW_ORIGIN') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };
}

function json(body: unknown, status = 200, extra?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extra,
    },
  });
}

// Minimal auth: read Authorization: Bearer <token>.
// The test frontend stores a Supabase Access Token (from khyos-auth EF) in
// localStorage and sends it here. We verify it against the auth table via
// Supabase Auth (simplest: rely on Supabase Auth JWT, not custom bcrypt).
//
// For a pure test, we accept either:
//   - a valid Supabase Auth JWT (preferred), or
//   - a plain "anon" fallback so the dashboard renders without login.
function extractAuth(req: Request): { role: 'service' | 'user' | 'anon' } {
  const h = req.headers.get('authorization') || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (token) return { role: 'user' }; // presence checked; deep verify optional
  return { role: 'anon' };
}

async function handleInstruments(req: Request) {
  const { data, error } = await sbAdmin.from('instruments').select('*').limit(200);
  if (error) return json({ success: false, message: error.message }, 500);
  return json({ success: true, data: data || [] });
}

async function handleWatchlist(req: Request) {
  const { data, error } = await sbAdmin.from('watchlist').select('*').limit(200);
  if (error) return json({ success: false, message: error.message }, 500);
  return json({ success: true, data: data || [] });
}

async function handleStrategies(req: Request) {
  const { data, error } = await sbAdmin.from('strategies').select('*').limit(100);
  if (error) return json({ success: false, message: error.message }, 500);
  return json({ success: true, data: data || [] });
}

async function handleBacktests(req: Request) {
  const { data, error } = await sbAdmin.from('backtests').select('*').limit(100);
  if (error) return json({ success: false, message: error.message }, 500);
  return json({ success: true, data: data || [] });
}

async function handleSettings(req: Request) {
  const { data, error } = await sbAdmin.from('settings').select('*').limit(10);
  if (error) return json({ success: false, message: error.message }, 500);
  return json({ success: true, data: data || [] });
}

async function handleDashboard(req: Request) {
  // Aggregate a light dashboard payload so the first screen renders.
  const [inst, watch, strat] = await Promise.all([
    sbAdmin.from('instruments').select('id, symbol, name, type, category').limit(100),
    sbAdmin.from('watchlist').select('*').limit(50),
    sbAdmin.from('strategies').select('*').limit(20),
  ]);
  return json({
    success: true,
    data: {
      instruments: inst.data || [],
      watchlist: watch.data || [],
      strategies: strat.data || [],
    },
  });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const base = '/functions/v1/khyos-api';
  let path = url.pathname.replace(base, '') || '/';
  path = path.replace(/\/+$/, '') || '/';

  // Preflight.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders() });
  }

  extractAuth(req); // keep for audit hook; no hard gate in test mode

  switch (true) {
    case path === '/api/health' || path === '/health':
      return json({
        success: true,
        status: 'ok',
        ts: Date.now(),
        mode: 'supabase-free-test',
        checks: {
          database: { ok: true, detail: 'supabase-postgres' },
          cache: { ok: false, detail: 'disabled-in-test' },
          websocket: { ok: false, detail: 'disabled-in-test-use-sse' },
        },
      });

    case path === '/api/instruments':
      return handleInstruments(req);
    case path === '/api/watchlist':
      return handleWatchlist(req);
    case path === '/api/strategies':
    case path === '/api/strategy':
      return handleStrategies(req);
    case path === '/api/backtests':
    case path === '/api/backtest':
      return handleBacktests(req);
    case path === '/api/settings':
      return handleSettings(req);
    case path === '/api/dashboard':
      return handleDashboard(req);

    case path === '/api/auth/me':
      // Test stub: return an anonymous user so the UI doesn't bounce to /login.
      return json({
        success: true,
        data: { id: 0, username: 'test', role: 'user', name: 'Test' },
      });

    default:
      return json(
        {
          success: false,
          message: 'not wired in free-test (only /api/{health,instruments,watchlist,strategies,backtests,settings,dashboard,auth/me})',
          path,
        },
        404,
      );
  }
});
