#!/usr/bin/env node
/**
 * demo.js — Cross-Platform Delivery Tool demo
 *
 * Run: node platform/delivery/demo.js
 *
 * This demo shows how to use the DeliveryController
 * without actually sending to external platforms.
 */

const path = require('path');
const { DeliveryController } = require('./deliveryController');

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Cross-Platform Delivery Tool — Demo                    ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Initialize with mock config (no real API keys)
  const controller = new DeliveryController({
    platforms: {
      slack: {
        botToken: 'xoxb-test-token',
        channel: '#general',
      },
      notion: {
        apiKey: 'secret_test_key',
        defaultPageId: 'page_123',
      },
      markdown: {
        outputDir: path.join(__dirname, 'demo-output'),
      },
      webhook: {
        defaultUrl: 'https://httpbin.org/post',
      },
      email: {
        // No SMTP config — email adapter will report unavailable
      },
    },
    maxConcurrency: 3,
    maxRetries: 2,
  });

  await controller.init();

  // Show adapter status
  console.log('── Adapter Status ──────────────────────────────────────────');
  const adapters = controller.getAdapterStatus();
  for (const a of adapters) {
    console.log(`  ${a.platform.padEnd(12)} available=${a.available ? '✓' : '✗'}  configValid=${a.configValid ? '✓' : '✗'}  formats=[${a.supportedFormats.join(', ')}]`);
  }

  // Show available templates
  console.log('\n── Available Prompt Templates ──────────────────────────────');
  const templates = controller.listTemplates();
  for (const t of templates) {
    const preview = controller.getPrompt(t)?.slice(0, 80).replace(/\n/g, ' ') || '';
    console.log(`  ${t}: ${preview}...`);
  }

  // Demo 1: Markdown delivery (always works)
  console.log('\n── Demo 1: Markdown Delivery ────────────────────────────────');
  const mdReport = await controller.deliver({
    content: `# Weekly Status Report\n\n## Summary\nAll systems operational.\n\n| Service | Status | Uptime |\n|---------|--------|--------|\n| API     | OK     | 99.9%  |\n| DB      | OK     | 99.8%  |\n| CDN     | OK     | 100%   |\n\n## Action Items\n- Review Q3 targets :calendar:\n- Update documentation :memo:`,
    format: 'markdown',
    platforms: ['markdown'],
    metadata: { author: 'demo', tags: ['status-report'] },
  });

  console.log(`  Status:    ${mdReport.final_decision}`);
  console.log(`  Duration:  ${mdReport.execution_time_ms}ms`);
  for (const d of mdReport.deliveries) {
    console.log(`  [${d.platform}] success=${d.success} file=${d.result?.filepath}`);
  }

  // Demo 2: Multi-platform (markdown + webhook + slack simulation)
  console.log('\n── Demo 2: Multi-Platform Delivery ──────────────────────────');
  const multiReport = await controller.deliver({
    content: `# Deployment Notice\n\nVersion 2.4.0 has been deployed to production.\n\n**Changes:**\n- New dashboard feature\n- Performance improvements\n- Bug fixes\n\n:rocket:`,
    format: 'markdown',
    platforms: ['markdown', 'webhook', 'slack'],
    priority: 1,
    metadata: { author: 'deploy-bot', tags: ['deployment'] },
  });

  console.log(`  Status:    ${multiReport.final_decision}`);
  console.log(`  Duration:  ${multiReport.execution_time_ms}ms`);
  for (const d of multiReport.deliveries) {
    console.log(`  [${d.platform}] success=${d.success} ${d.result?.error ? `error=${d.result.error}` : ''}`);
  }

  if (multiReport.diff_report) {
    console.log(`  DiffEngine: ${multiReport.diff_report.overall_status} (${multiReport.diff_report.summary.failures}f, ${multiReport.diff_report.summary.warnings}w)`);
  }

  // Demo 3: Validation only
  console.log('\n── Demo 3: Validation Only ──────────────────────────────────');
  console.log('  (No actual delivery, just config check)');
  const adaptersStatus = controller.getAdapterStatus();
  const invalid = adaptersStatus.filter((a) => !a.configValid);
  console.log(`  Valid adapters: ${adaptersStatus.filter((a) => a.configValid).length}/${adaptersStatus.length}`);
  if (invalid.length > 0) {
    console.log(`  Invalid: ${invalid.map((i) => i.platform).join(', ')}`);
  }

  console.log('\n── Demo Complete ────────────────────────────────────────────');
  console.log(`  Output directory: ${path.join(__dirname, 'demo-output')}`);
  console.log('\n  Next steps:');
  console.log('  1. Set real API keys in config to enable live delivery');
  console.log('  2. Mount routes: app.use("/api/delivery", deliveryRoutes({ deliveryConfig }))');
  console.log('  3. Call POST /api/delivery/send with content + platforms');
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
