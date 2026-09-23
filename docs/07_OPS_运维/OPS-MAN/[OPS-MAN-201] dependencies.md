# Disaster Recovery Dependencies

> DR-001 reference: critical service dependency map for disaster recovery

## Critical Dependencies

### Infrastructure

| Component | Dependency | Impact if Lost | Recovery |
|-----------|-----------|----------------|----------|
| PostgreSQL | Primary DB | All services down | Promote replica |
| Redis | Session/cache | Auth failures, cache miss | Restart + warm cache |
| Ollama | Local LLM | AI features degraded | Fallback to cloud models |
| NVIDIA GPU | Local inference | Slow AI responses | CPU fallback or cloud |

### External Services

| Service | Dependency | Impact if Lost | Recovery |
|---------|-----------|----------------|----------|
| Zhipu AI API | GLM model access | AI features degraded | Retry + fallback |
| GitHub API | Issue/PR sync | Dev workflow blocked | Cache + retry |
| npm/PyPI | Package install | Deployment blocked | Use cached packages |

### Internal Services

| Service | Dependency | Impact if Lost | Recovery |
|---------|-----------|----------------|----------|
| aiManagementServer | Central gateway | All AI features down | Restart + health check |
| daemonEntry | Service manager | CLI commands fail | Restart daemon |
| proxyServer | Traffic routing | External access blocked | Failover to standby |

## Dependency Health Monitoring

- Health checks: `/health`, `/ready`, `/live`
- Alert thresholds: 3 consecutive failures = alert
- Circuit breaker: 50% failure rate = open circuit

## Recovery Priority

1. Infrastructure (DB, Redis, GPU)
2. Internal services (gateway, daemon)
3. External services (retry + fallback)

## Related

- [00_INDEX_运维-分类索引.md](../00_INDEX_运维-分类索引.md) - disaster recovery runbooks
- [incident-runbooks/00_INDEX_事件响应剧本-总目录.md](../incident-runbooks/00_INDEX_事件响应剧本-总目录.md) - incident response
