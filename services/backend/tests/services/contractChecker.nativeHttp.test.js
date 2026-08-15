'use strict';

const http = require('http');
const { checkContract } = require('../../src/services/workflow/contractChecker');

describe('contractChecker native HTTP transport', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(req.url === '/missing' ? 404 : 200);
      res.end('fixture');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  test('passes matching status and compares non-2xx responses', async () => {
    await expect(checkContract([{ type: 'httpStatus', url: `${baseUrl}/health` }]))
      .resolves.toMatchObject({ passed: true, results: [{ passed: true }] });
    await expect(checkContract([{ type: 'httpStatus', url: `${baseUrl}/missing`, expect: 404 }]))
      .resolves.toMatchObject({ passed: true, results: [{ passed: true }] });
  });

  test('reports network failures and skips unsupported protocols', async () => {
    await expect(checkContract([{ type: 'httpStatus', url: 'http://127.0.0.1:1/health' }]))
      .resolves.toMatchObject({ passed: false, results: [{ passed: false }] });
    await expect(checkContract([{ type: 'httpStatus', url: 'file:///fixture' }]))
      .resolves.toMatchObject({ passed: true, results: [{ skipped: true }] });
  });
});
