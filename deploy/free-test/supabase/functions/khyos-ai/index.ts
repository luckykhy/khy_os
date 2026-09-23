// khyos-ai — LLM streaming proxy for Supabase Edge Functions (Deno).
//
// The khy-os frontend already does AI streaming over `fetch + ReadableStream`
// (see apps/ai-frontend/src/api/request.js — "streaming chat uses fetch()").
// So this EF just forwards to an OpenAI-compatible upstream and streams the
// SSE body back. Zero frontend code change: point VITE_AI_API_BASE_URL here.
//
// Deploy: supabase functions deploy khyos-ai
// Secrets to set:
//   LLM_UPSTREAM_URL  e.g. https://openrouter.ai/api/v1
//   LLM_API_KEY       your key
//   LLM_MODEL         optional default model
//   ALLOW_ORIGIN      GitHub Pages origin

Deno.serve(async (req) => {
  const origin = Deno.env.get('ALLOW_ORIGIN') || '*';
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers });
  }

  const upstream =
    Deno.env.get('LLM_UPSTREAM_URL') || 'https://openrouter.ai/api/v1';
  const apiKey = Deno.env.get('LLM_API_KEY') || '';
  if (!apiKey) {
    return new Response(
      JSON.stringify({ success: false, message: 'LLM_API_KEY not set' }),
      { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } },
    );

  const body = await req.json().catch(() => ({}));
  const model = Deno.env.get('LLM_MODEL') || body.model || 'openai/gpt-4o-mini';

  const resp = await fetch(`${upstream}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      ...body,
      model,
      stream: true,
    }),
  });

  if (!resp.ok || !resp.body) {
    const text = await resp.text();
    return new Response(
      JSON.stringify({ success: false, message: `upstream ${resp.status}`, detail: text.slice(0, 500) }),
      { status: 502, headers: { ...headers, 'Content-Type': 'application/json' } },
    );
  }

  // Stream the SSE body back. Supabase EF supports ReadableStream passthrough.
  return new Response(resp.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...headers,
    },
  });
});
