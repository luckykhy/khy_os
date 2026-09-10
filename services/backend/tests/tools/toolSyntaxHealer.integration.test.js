'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { healFile } = require('../../src/tools/_toolSyntaxHealer');
// ── Integration: healFile + require retry ─────────────────────────────

describe('Tool Syntax Healer integration', () => {
  test('healFile fixes a broken tool file so it can be required', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-heal-int-'));
      const toolDir = path.join(tmpDir, 'BrokenTool');
      fs.mkdirSync(toolDir);
      const indexPath = path.join(toolDir, 'index.js');
    
      // Self-contained broken tool (no external requires)
      fs.writeFileSync(
        indexPath,
        `'use strict';
    
    class BrokenTool {
      static toolName = 'BrokenTool';
      static category = 'custom';
      static risk = 'low';
      static aliases = ['broken'];
      static searchHint: 'this should be = not :';
      static shouldDefer = false;
    
      isReadOnly() { return true; }
      isConcurrencySafe() { return true; }
    
      prompt() { return 'A broken tool for testing'; }
      get inputSchema() { return { type: 'object', properties: {} }; }
      async execute(params) { return { success: true }; }
    }
    
    module.exports = BrokenTool;
    `,
        'utf-8'
      );
    
      // Verify it fails to require BEFORE healing
      let threwBefore = false;
      try {
        delete require.cache[require.resolve(indexPath)];
        require(indexPath);
      } catch (err) {
        threwBefore = true;
        expect(err instanceof SyntaxError).toBeTruthy();
      }
      expect(threwBefore).toBeTruthy();
    
      // Heal the file
      const result = healFile(indexPath);
      expect(result.healed).toBe(true);
      expect(result.changes.length > 0).toBeTruthy();
    
      // Verify it can be required AFTER healing
      delete require.cache[require.resolve(indexPath)];
      let exported;
      let threwAfter = false;
      try {
        exported = require(indexPath);
      } catch {
        threwAfter = true;
      }
      expect(threwAfter).toBe(false, 'should not throw after healing');
    
      // Verify the export is usable
      expect(exported).toBeTruthy();
      expect(exported.toolName).toBe('BrokenTool', 'should have correct toolName');
      expect(exported.searchHint).toBe('this should be = not :', 'searchHint should be preserved');
    
      fs.rmSync(tmpDir, { recursive: true, force: true });
  });

});

