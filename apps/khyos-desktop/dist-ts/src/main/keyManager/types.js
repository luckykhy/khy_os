// keyManager types & constants — shared contracts for the Key/Endpoint Manager.
//
// P1 (DESIGN-ARCH-091): types only. The runtime lives in keyStore.ts /
// agentWriters.ts / health.ts / proxyStatus.ts / audit.ts.
// protocol → env var pair used by the backend ENV_KEY_MAP overlay.
// GUI shows a badge when the env var is set (read-only view).
export const ENV_PROVIDER_MAP = {
    openai: { keyEnv: 'OPENAI_API_KEY', endpointEnv: 'OPENAI_BASE_URL' },
    anthropic: { keyEnv: 'ANTHROPIC_API_KEY', endpointEnv: 'ANTHROPIC_BASE_URL' },
    deepseek: { keyEnv: 'DEEPSEEK_API_KEY', endpointEnv: 'DEEPSEEK_API_ENDPOINT' },
    agnes: { keyEnv: 'AGNES_API_KEY', endpointEnv: 'AGNES_API_ENDPOINT' },
    sensenova: { keyEnv: 'SENSENOVA_API_KEY', endpointEnv: 'SENSENOVA_API_ENDPOINT' },
    qwen: { keyEnv: 'QWEN_API_KEY', endpointEnv: 'QWEN_API_ENDPOINT' },
    glm: { keyEnv: 'GLM_API_KEY', endpointEnv: 'GLM_API_ENDPOINT' },
    doubao: { keyEnv: 'DOUBAO_API_KEY', endpointEnv: 'DOUBAO_API_ENDPOINT' },
    wenxin: { keyEnv: 'WENXIN_API_KEY', endpointEnv: 'WENXIN_API_ENDPOINT' },
    trae: { keyEnv: 'TRAE_API_KEY', endpointEnv: 'TRAE_API_ENDPOINT' },
    openrouter: { keyEnv: 'OPENROUTER_API_KEY', endpointEnv: 'OPENROUTER_BASE_URL' },
    relay: { keyEnv: 'RELAY_API_KEY', endpointEnv: 'RELAY_API_ENDPOINT' }
};
// P1 agent matrix (DESIGN-ARCH-091 §8/§8b.3): three high-frequency agents
// for Mode B one-click activation; the rest land in P2/P3.
export const P1_APPS = ['claude-code', 'opencode', 'qodercli'];
export const APP_LABELS = {
    'claude-code': 'Claude Code',
    opencode: 'OpenCode',
    qodercli: 'Qoder CLI'
};
// reveal rate limit: one reveal per key per window (spec §7.1)
export const REVEAL_COOLDOWN_MS = 60_000;
// short I/O probe timeout — legal exception class (AGENTS.md rule 3: handshake)
export const PROBE_TIMEOUT_MS = 10_000;
export const VALIDATE_TIMEOUT_MS = 3_000;
export const PROBE_CONCURRENCY = 4;
// proxy runtime files under dataHome (written by services/backend proxyServer)
export const PROXY_RUNTIME_FILE = 'proxy_server_runtime.json';
export const PROXY_AUTH_FILE = 'proxy_server_auth.json';
// keyManager data files under dataHome
export const API_KEYS_FILE = 'api_keys.json';
export const CUSTOM_PROVIDERS_FILE = 'custom_providers.json';
export const CC_SWITCH_FILE = 'cc_switch.json';
export const AUDIT_FILE = 'key_manager_audit.jsonl';
