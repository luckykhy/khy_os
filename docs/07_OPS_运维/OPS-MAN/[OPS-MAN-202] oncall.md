# On-Call Schedule

> IR-001 reference: oncall schedule for incident response

## Current On-Call Rotation

| Week | Primary | Secondary |
|------|---------|-----------|
| W1 | Platform Lead | Senior Backend |
| W2 | Senior Backend | Platform Lead |
| W3 | DevOps Lead | Platform Lead |
| W4 | Platform Lead | DevOps Lead |

## Escalation Path

1. Primary on-call engineer
2. Secondary on-call engineer
3. Team lead (within 30 min if P0/P1)
4. Director (within 1 hour if P0)

## On-Call Responsibilities

- Monitor alerts in `#khy-os-alerts` (Slack)
- Acknowledge P0/P1 alerts within SLA
- Create incident ticket for all P0/P1/P2
- Run incident response per runbook

## Incident Response SLA

| Phase | Target Time |
|-------|-------------|
| Acknowledge | 15 minutes (P0), 1 hour (P1), 4 hours (P2) |
| Initial assessment | 1 hour (P0/P1), 4 hours (P2) |
| Fix and publish | Priority-based, sync during process |

## Related

- [事件响应剧本总目录](../incident-runbooks/00_INDEX_事件响应剧本-总目录.md) - incident response runbooks
- [灾备演练剧本总目录](../runbooks/00_INDEX_灾备演练剧本-总目录.md) - disaster recovery runbooks
