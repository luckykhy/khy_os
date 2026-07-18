const { BaseTool } = require('../_baseTool');
const fs = require('fs');
const path = require('path');

class DiscoverSkillsTool extends BaseTool {
  static toolName = 'DiscoverSkills';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['discover_skills', 'list_skills'];
  static searchHint = 'discover skills list available commands';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Discover and list available skills (slash commands).
Skills are reusable prompt templates that extend CLI capabilities.
Shows both built-in and user-created skills.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter skills by name or description' },
      },
    };
  }

  async execute(params) {
    const skillDirs = [
      path.join(__dirname, '..', '..', 'skills', 'built-in'),
      path.join(process.cwd(), '.khy', 'skills'),
      path.join(require('os').homedir(), '.khy', 'skills'),
    ];

    const skills = [];
    for (const dir of skillDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(dir, entry.name, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          skills.push({
            name: manifest.name || entry.name,
            command: manifest.command || `/${entry.name}`,
            description: manifest.description || '',
            source: dir.includes('built-in') ? 'built-in' : 'user',
          });
        } catch { /* skip */ }
      }
    }

    const query = (params.query || '').toLowerCase();
    const filtered = query
      ? skills.filter(s => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query))
      : skills;

    return { success: true, skills: filtered, total: filtered.length };
  }
}

module.exports = DiscoverSkillsTool;
