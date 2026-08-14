/**
 * sqlite-adapter.js - forward to the @khy/shared dual-driver SQLite adapter.
 *
 * Resolved through the @khy/shared package (services/backend declares
 * "@khy/shared": "file:./vendor/shared"; in a dev checkout vendor/shared is a
 * symlink to platform/packages/shared, in a published tarball it is a real copy),
 * avoiding fragile cross-package relative paths after packing/moving.
 */

'use strict';

module.exports = require('@khy/shared/config/sqlite-adapter');
