/**
 * User-domain workflow routes (multi-tenant).
 *
 * Mounts at /api/workflow with `authenticateToken` only — NO requireAdmin.
 * Every handler is scoped to `req.user.id`, so a user can only read/write their
 * own visual workflows. Deliberate clone of the user-gateway surface
 * (userGateway.js): same `userId(req)` resolution, `{ success, data }`
 * envelope, and `fail(res, err)` status mapping.
 *
 * CRUD delegates to `workflowService`; the node-type catalog comes from the
 * shared `nodeCatalog`, and `POST /:id/export` derives harness Markdown via
 * `workflowExportService`.
 *
 * @pattern Proxy
 */
'use strict';

const express = require('express');
const router = express.Router();

const { authenticateToken } = require('../middleware/auth');
const svc = require('../services/workflowService');
const exportSvc = require('../services/workflowExportService');
const runSvc = require('../services/workflowRunService');
const generateSvc = require('../services/workflowGenerateService');
const { getCatalog } = require('@khy/shared/workflow/nodeCatalog');

// All routes require a logged-in user (JWT or API key). No admin gate.
router.use(authenticateToken);

// 收敛到 utils/reqUserId 单一真源(逐字节委托,调用点不变)
const userId = require('../utils/reqUserId');

function fail(res, err) {
  const code = err && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  const message = (err && err.message) || 'Internal server error';
  if (code >= 500) console.error('[workflow]', err);
  res.status(code).json({ success: false, message });
}

// ── Workflow CRUD (per-user) ────────────────────────────────────────────────

// GET /api/workflow — list this user's workflows (summary only)
router.get('/', async (req, res) => {
  try {
    const data = await svc.list(userId(req));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/workflow/node-types — node-type catalog for palette + property panel
// (declared before /:id so it is not captured as an id param)
router.get('/node-types', (req, res) => {
  try {
    res.json({ success: true, data: getCatalog() });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/workflow/templates — built-in template catalog for the "从模板新建"
// picker (summary only; declared before /:id so "templates" is not an id param)
router.get('/templates', (req, res) => {
  try {
    res.json({ success: true, data: svc.listTemplates() });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/workflow/templates/:templateId — instantiate a built-in template as a
// new workflow for the calling user. Optional body { name, description } overrides
// the template defaults.
router.post('/templates/:templateId', async (req, res) => {
  try {
    const data = await svc.createFromTemplate(userId(req), req.params.templateId, req.body || {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/workflow/import/coze — import a Coze (coze-studio) exported workflow
// as a new workflow for the calling user. Body: { content | contentBase64 | nodes,
// optional name, description }. Two-segment literal path, so it never collides with
// the /:id family. Returns the created workflow plus the conversion `report`.
router.post('/import/coze', async (req, res) => {
  try {
    const data = await svc.createFromCoze(userId(req), req.body || {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/workflow/import/coze/enumerate — list EVERY workflow in an uploaded
// Coze collection (possibly nested zip) WITHOUT persisting. Body: { content |
// contentBase64 }. Returns { sessionId, total, skipped, entries[] } where each
// entry carries a preview report (node count, unsupported/degraded nodes).
router.post('/import/coze/enumerate', async (req, res) => {
  try {
    const data = await svc.enumerateCoze(userId(req), req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/workflow/import/coze/catalog — enumerate the server-side built-in
// catalog (KHY_COZE_CATALOG_DIR). Empty/missing directory degrades to an empty
// catalog. Same shape as /enumerate plus { builtin }.
router.get('/import/coze/catalog', async (req, res) => {
  try {
    const data = await svc.enumerateCozeBuiltin(userId(req));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/workflow/import/coze/install — install one enumerated entry as a new
// workflow. Body: { sessionId, index, name?, description? }. Returns the created
// workflow + conversion report (201), mirroring /import/coze.
router.post('/import/coze/install', async (req, res) => {
  try {
    const data = await svc.installCozeEntry(userId(req), req.body || {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/workflow/generate — build a workflow graph from a natural-language
// description using the calling user's own AI upstream. Body: { prompt, model?,
// persist? }. Default returns { graph, name, description, report } WITHOUT
// saving (the editor previews then POSTs to create); persist:true returns the
// created workflow too. Literal path, declared before /:id so "generate" is not
// captured as an id.
router.post('/generate', async (req, res) => {
  try {
    const body = req.body || {};
    const data = await generateSvc.generate(userId(req), {
      prompt: body.prompt,
      model: body.model,
      persist: !!body.persist,
    });
    res.status(body.persist ? 201 : 200).json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/workflow/runs/:runId — read one run (status + per-node log) for polling.
// Declared before /:id so the literal "runs" segment is not captured as an id.
router.get('/runs/:runId', async (req, res) => {
  try {
    const data = await runSvc.getRun(userId(req), req.params.runId);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/workflow/runs/:runId/answer — answer a run parked at askUserQuestion
router.post('/runs/:runId/answer', async (req, res) => {
  try {
    const data = await runSvc.answer(userId(req), req.params.runId, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/workflow/runs/:runId/events — SSE live run status.
//
// The worker (services/backend) executes runs and writes status + log into the
// shared `workflow_runs` row; this process has no IPC to it, only the DB. So we
// server-side-poll the row and push each change to the client over ONE long-lived
// connection, replacing repeated client HTTP polls. Honest bridge: DB-poll here,
// push to the browser. The stream ends as soon as the run reaches a terminal
// (succeeded/failed) or parked (awaiting_input) state.
const SSE_POLL_MS = Number(process.env.KHY_WORKFLOW_SSE_MS || 800);
const SSE_HALT = new Set(['succeeded', 'failed', 'awaiting_input']);

router.get('/runs/:runId/events', async (req, res) => {
  const uid = userId(req);
  const runId = req.params.runId;

  // Ownership / existence check BEFORE upgrading to a stream, so a 404/JSON error
  // surfaces normally rather than as a dead stream.
  let initial;
  try {
    initial = await runSvc.getRun(uid, runId);
  } catch (err) {
    return fail(res, err);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  let lastSig = null;
  // Declared up front (not const) so cleanup() is safe to call from the early
  // terminal/parked `finish()` below — before the intervals are ever assigned.
  let keepalive = null;
  let poll = null;
  function cleanup() {
    if (poll) { clearInterval(poll); poll = null; }
    if (keepalive) { clearInterval(keepalive); keepalive = null; }
  }
  const send = (view) => {
    lastSig = `${view.status}:${(view.log || []).length}`;
    res.write(`data: ${JSON.stringify(view)}\n\n`);
  };
  const finish = (view) => {
    if (closed) return;
    closed = true;
    if (view) send(view);
    res.write('event: done\ndata: {}\n\n');
    cleanup();
    res.end();
  };

  // Initial snapshot — and stop immediately if already terminal/parked.
  send(initial);
  if (SSE_HALT.has(initial.status)) return finish();

  keepalive = setInterval(() => {
    if (!closed) { try { res.write(': keepalive\n\n'); } catch { cleanup(); } }
  }, 25000);

  poll = setInterval(async () => {
    if (closed) return;
    try {
      const view = await runSvc.getRun(uid, runId);
      const sig = `${view.status}:${(view.log || []).length}`;
      if (sig !== lastSig) send(view);
      if (SSE_HALT.has(view.status)) finish();
    } catch {
      // Transient read failure — keep the stream open and retry next tick.
    }
  }, SSE_POLL_MS);

  req.on('close', () => { closed = true; cleanup(); });
});

// GET /api/workflow/:id — load one workflow with its full canvas graph
router.get('/:id', async (req, res) => {
  try {
    const data = await svc.get(userId(req), req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/workflow — create a new workflow
router.post('/', async (req, res) => {
  try {
    const data = await svc.create(userId(req), req.body || {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/workflow/:id — save (graph/name/description); bumps version
router.put('/:id', async (req, res) => {
  try {
    const data = await svc.save(userId(req), req.params.id, req.body || {});
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/workflow/:id/export — derive agent Markdown (SKILL.md + agents).
// Optional body { provider } selects the target agent (default 'khy'); see
// @khy/shared/workflow/exportProviders for the allowlist.
router.post('/:id/export', async (req, res) => {
  try {
    const body = req.body || {};
    const data = await exportSvc.exportWorkflow(userId(req), req.params.id, {
      provider: body.provider,
    });
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/workflow/:id/run — snapshot + enqueue a native execution run
router.post('/:id/run', async (req, res) => {
  try {
    const data = await runSvc.enqueue(userId(req), req.params.id, req.body || {});
    res.status(201).json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/workflow/:id/runs — list this workflow's runs (most recent first)
router.get('/:id/runs', async (req, res) => {
  try {
    const data = await runSvc.listRuns(userId(req), req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/workflow/:id — remove one of this user's workflows
router.delete('/:id', async (req, res) => {
  try {
    const data = await svc.remove(userId(req), req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
