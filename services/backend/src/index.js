'use strict';

/**
 * KHY OS Backend — Programmatic entry point.
 *
 * Re-exports key services and utilities for bundled builds.
 * This file is the esbuild entry point for library mode.
 *
 * @module khy-os-backend
 */

// ── Core Services ──
exports.configMigration = require('./services/configMigration');
exports.extensionMarketplace = require('./services/extensionMarketplace');
exports.promptCacheService = require('./services/promptCacheService');
exports.sessionTitleService = require('./services/sessionTitleService');
exports.sessionRecapService = require('./services/sessionRecapService');
exports.followupSuggestionService = require('./services/followupSuggestionService');
exports.arenaManager = require('./services/arenaManager');
exports.lspClient = require('./services/lspClient');

// ── i18n ──
exports.i18n = require('./i18n');

// ── MCP ──
exports.mcpOAuthTokenStore = require('./services/mcp/oauthTokenStore');

// ── Utils ──
exports.logger = require('./utils/logger');
