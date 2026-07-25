'use strict';

const { defineTool } = require('./_baseTool');
const { loadTemplates, matchTemplate, renderTemplate, listTemplates } = require('../services/projectTemplateService');

module.exports = defineTool({
  name: 'projectTemplate',
  description: 'Load and render a project template, producing scaffoldFiles-compatible output for batch project creation.',
  category: 'filesystem',
  risk: 'low',
  aliases: ['project_template', 'load_template'],
  searchHint: 'project template scaffold SSM Spring Boot Maven React Express',
  alwaysLoad: false,
  isReadOnly: true,
  maxResultSizeChars: 8000,

  async prompt() {
    const templates = listTemplates();
    const names = templates.map(t => `  - ${t.name}: ${t.description}`).join('\n');
    return [
      'Load a project template and render it with variable values.',
      'The rendered output is scaffoldFiles-compatible — pass it directly to scaffoldFiles to create the project.',
      '',
      'Available templates:',
      names || '  (none)',
      '',
      'Usage: specify "template" (name) and optional "variables" object.',
      'If "action" is "list", returns all available templates without rendering.',
    ].join('\n');
  },

  inputSchema: {
    template: {
      type: 'string',
      required: false,
      description: 'Template name to render (e.g., "spring-boot-mybatis"). Omit if action is "list".',
    },
    variables: {
      type: 'object',
      required: false,
      description: 'Variable overrides for the template, e.g. { "groupId": "com.example", "artifactId": "myapp" }.',
    },
    action: {
      type: 'string',
      required: false,
      description: '"list" to list available templates, "render" (default) to render a template.',
    },
  },

  async validateInput(input) {
    const action = String(input?.action || 'render').toLowerCase();
    if (action === 'list') return { valid: true };
    if (!input?.template) {
      return { valid: false, message: 'Provide a "template" name, or set action to "list" to see available templates.' };
    }
    return { valid: true };
  },

  getActivityDescription(input) {
    const action = String(input?.action || 'render').toLowerCase();
    if (action === 'list') return '列出项目模板';
    return `渲染模板：${input?.template || '?'}`;
  },

  async execute(params) {
    try {
      const action = String(params?.action || 'render').toLowerCase();

      if (action === 'list') {
        const templates = listTemplates();
        return {
          success: true,
          templates,
          count: templates.length,
          hint: 'Use projectTemplate with a template name and variables to render, then pass the output to scaffoldFiles.',
        };
      }

      const rendered = renderTemplate(params.template, params.variables || {});
      return {
        success: true,
        name: rendered.name,
        description: rendered.description,
        root: '.',
        directories: rendered.directories,
        files: rendered.files,
        variables: rendered.variables,
        hint: 'Pass this output directly to scaffoldFiles to create the project structure.',
      };
    } catch (err) {
      return { success: false, error: err.message || 'projectTemplate failed.' };
    }
  },
});
