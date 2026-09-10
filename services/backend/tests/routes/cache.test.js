'use strict';

const express = require('express');
const request = require('supertest');
const router = require('../../src/routes/cache');

describe('cache routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/cache', router);
  });

  test('router is defined', () => {
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  test('POST /cache/save-instrument-data route exists', async () => {
    const res = await request(app).post('/cache/save-instrument-data').send({});
    expect(res.status).not.toBe(404);
  });

  test('POST /cache/batch-save route exists', async () => {
    const res = await request(app).post('/cache/batch-save').send({});
    expect(res.status).not.toBe(404);
  });

  test('GET /cache/kline-data/:symbol route exists', async () => {
    const res = await request(app).get('/cache/kline-data/AAPL');
    expect(res.status).not.toBe(404);
  });

  test('GET /cache/stats/:symbol route exists', async () => {
    const res = await request(app).get('/cache/stats/AAPL');
    expect(res.status).not.toBe(404);
  });

  test('POST /cache/save-instrument-data accepts JSON body', async () => {
    const res = await request(app)
      .post('/cache/save-instrument-data')
      .send({ symbol: 'AAPL', data: [] })
      .set('Content-Type', 'application/json');
    expect(res.status).not.toBe(404);
  });

  test('POST /cache/batch-save accepts JSON body', async () => {
    const res = await request(app)
      .post('/cache/batch-save')
      .send({ instruments: [] })
      .set('Content-Type', 'application/json');
    expect(res.status).not.toBe(404);
  });

  test('GET /cache/kline-data/:symbol with special symbol', async () => {
    const res = await request(app).get('/cache/kline-data/BRK.B');
    expect(res.status).not.toBe(404);
  });

  test('GET /cache/stats/:symbol with special symbol', async () => {
    const res = await request(app).get('/cache/stats/BRK.B');
    expect(res.status).not.toBe(404);
  });

  test('router has correct number of routes', () => {
    const routes = router.stack.filter((layer) => layer.route);
    expect(routes.length).toBe(4);
  });

  test('router routes have correct methods', () => {
    const routes = router.stack.filter((layer) => layer.route);
    const methods = routes.map((r) => r.route.stack[0].method);
    expect(methods).toContain('post');
    expect(methods).toContain('get');
  });
});

