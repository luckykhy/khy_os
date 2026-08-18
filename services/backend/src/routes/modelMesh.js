'use strict';

const express = require('express');
const { authorize, localCapabilities } = require('../services/modelMesh');

const router = express.Router();

router.use((req, res, next) => {
  if (!authorize(req.get('x-khy-mesh-token'))) {
    return res.status(401).json({ success: false, error: 'mesh authentication failed' });
  }
  next();
});

router.get('/capabilities', (_req, res) => {
  res.json({ success: true, ...localCapabilities() });
});

router.post('/generate', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
  if (!prompt.trim()) {
    return res.status(400).json({ success: false, error: 'prompt is required' });
  }
  try {
    const gateway = require('../services/gateway/aiGateway');
    const options = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
    const result = await gateway.generate(prompt, {
      ...options,
      _meshHop: Math.max(1, Number(options._meshHop || 1)),
    });
    res.status(result?.success === false ? 502 : 200).json(result);
  } catch (error) {
    res.status(502).json({
      success: false,
      error: String(error?.message || 'remote generation failed').slice(0, 240),
    });
  }
});

module.exports = router;
