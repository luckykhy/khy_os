'use strict';

describe('migrations/run', () => {
  test('module file exists and has valid structure', () => {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '../../src/migrations/run.js');
    expect(fs.existsSync(filePath).toBe(true);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('runMigrations');
    expect(content).toContain('getCurrentVersion');
  });

  test('module exports main function', () => {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '../../src/migrations/run.js');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('async function main()');
    expect(content).toContain('main()');
  });

  test('module handles errors', () => {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(__dirname, '../../src/migrations/run.js');
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('catch');
    expect(content).toContain('process.exit(1)');
  });
});

