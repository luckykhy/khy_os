/**
 * @khy/shared — Shared infrastructure for KHY-Quant systems.
 *
 * Used by both the Trading backend and the AI Management backend.
 * Exports: models, middleware, config, services, utils.
 * @pattern Strategy
 */

// Config
const database = require('./config/database');
const env = require('./config/env');

// Models
const models = require('./models');

// Middleware
const auth = require('./middleware/auth');

// Re-export everything
module.exports = {
  // Database
  sequelize: database.sequelize,
  initDatabase: database.initDatabase || database.sequelize,

  // Models (flat)
  ...models,
  models,

  // Middleware
  ...auth,
  auth,

  // Config
  database,
  env,
};
