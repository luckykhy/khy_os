// Auto-generated shim - re-exports from new domain location
// Do not edit - move services/backend/src/services/domain/eval/webFrontendEval instead
//
// NOTE: this must re-export the *service* facade, never routes/ — requiring the
// route module here is circular (routes/webFrontendEval.js -> this file -> route
// module), which resolves the router's own half-built exports back into `service`
// and makes every service.* call throw "service.X is not a function".

module.exports = require('../domain/eval/webFrontendEval');
