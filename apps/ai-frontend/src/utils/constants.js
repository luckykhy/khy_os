export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
export const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL || 'ws://localhost:5000';

export const APP_NAME = 'KHY AI Management';
export const APP_VERSION = '1.1.9';

export const PROVIDER_TYPES = {
  CLAUDE: 'claude',
  QWEN: 'qwen',
  CURSOR: 'cursor',
  KIRO: 'kiro',
  OLLAMA: 'ollama'
};

export const AGENT_STATUS = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  ERROR: 'error'
};

export const LOG_LEVELS = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR'
};
