# Incident Response Runbooks

> IR-001 reference: incident response documentation

## Overview

This directory contains runbooks for incident response.

## Incident Severity Levels

|Severity|Description|Response Time|Escalation|状态|
|----------|-------------|---------------|------------| --- |
|P0|Complete outage / data breach|15 min|Incident Commander + oncall|在产|
|P1|Major degradation|1 hour|Team lead + oncall|在产|
|P2|Minor issue / workaround exists|4 hours|Assigned engineer|在产|
|P3|Cosmetic / enhancement|Next sprint|Backlog|在产|

## Incident Commander

- Responsible for P0/P1 incidents
- Authorized to escalate to leadership
- Coordinates cross-team response

## Escalation Matrix

```
P0: Incident Commander → VP Engineering → CEO
P1: Team Lead → Director → VP Engineering
P2: Assigned Engineer → Team Lead
P3: Backlog → Next sprint planning
```

## Postmortem Template

See [postmortem-template.md](postmortem-template.md).

## Related

- [[OPS-MAN-202] oncall](../OPS-MAN/[OPS-MAN-202] oncall.md) - oncall schedule
- [../runbooks/](../runbooks/) - disaster recovery runbooks
