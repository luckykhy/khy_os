/**
 * Apply backend environment defaults once at startup.
 * @pattern Flyweight
 */
function applyEnvDefaults() {
  // OS-mode overrides: when running as the primary OS service, force stable
  // defaults that prevent auto-shutdown, port hopping, and DB probing.
  if (process.env.KHY_OS_MODE === 'true') {
    const osDefaults = {
      NODE_ENV: 'production',
      IDLE_SHUTDOWN: 'false',
      PORT_AUTO_RETRY: '0',
      DB_TYPE: 'sqlite',
      DB_PATH: process.env.DB_PATH || '/var/lib/khy-os/khy-quant.db',
    };
    for (const [k, v] of Object.entries(osDefaults)) {
      if (process.env[k] === undefined || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  }

  const defaults = {
    NODE_ENV: 'development',
    PORT: '3000',
    KHY_OS_MODE: 'false',
    DB_TYPE: 'auto',
    DB_QUERY_TIMEOUT_MS: '30000',
    AKSHARE_SCRIPT_TIMEOUT_MS: '30000',
    RATE_LIMIT_API_MAX: '600',
    RATE_LIMIT_AUTH_MAX: '30',
    RATE_LIMIT_AI_MAX: '120',
    TRADING_AGENT_ANALYZE_TIMEOUT_MS: '30000',
    TRADING_AGENT_ML_TIMEOUT_MS: '20000',
    TRADING_AGENT_STOCK_TIMEOUT_MS: '15000',
    DB_SYNC_ALTER: 'false'
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
    }
  }
}

/**
 * Validate required environment variables at startup.
 * Production: throw on failure. Development: warn loudly.
 */
function validateRequiredEnv() {
  const errors = [];

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET must be set and at least 32 characters long');
  }
  const WEAK_SECRETS = ['secret', 'jwt_secret', 'changeme', 'test', 'development'];
  if (WEAK_SECRETS.includes((process.env.JWT_SECRET || '').toLowerCase())) {
    errors.push('JWT_SECRET is a known weak value; generate a random secret');
  }

  const port = Number(process.env.PORT);
  if (process.env.PORT && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    errors.push('PORT must be a valid number between 1 and 65535');
  }

  const validDbTypes = ['sqlite', 'postgres', 'auto'];
  if (process.env.DB_TYPE && !validDbTypes.includes(process.env.DB_TYPE)) {
    errors.push(`DB_TYPE must be one of: ${validDbTypes.join(', ')}`);
  }

  if (process.env.DB_TYPE === 'postgres') {
    for (const key of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      if (!process.env[key]) {
        errors.push(`${key} is required when DB_TYPE=postgres`);
      }
    }
  }

  if (errors.length > 0) {
    const msg = 'Environment validation failed:\n  - ' + errors.join('\n  - ');
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    } else {
      console.warn('\x1b[33m[WARNING] ' + msg + '\x1b[0m');
    }
  }
}

module.exports = { applyEnvDefaults, validateRequiredEnv };
