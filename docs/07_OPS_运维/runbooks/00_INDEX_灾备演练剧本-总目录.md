# Disaster Recovery Runbooks

> DR-001 reference: disaster recovery documentation

## Overview

This directory contains runbooks for disaster recovery.

## RTO/RPO Targets

|Scenario|RTO (Recovery Time Objective)|RPO (Recovery Point Objective)|状态|
|----------|-------------------------------|-------------------------------| --- |
|Single node failure|5 minutes|0 (synchronous replication)|在产|
|Database failover|30 seconds|0 (synchronous replication)|在产|
|Full region outage|1 hour|15 minutes (async replication)|在产|
|Data corruption|2 hours|1 hour (last verified backup)|在产|

## Backup Verification

- Daily automated backup verification (see `scripts/maintenance/verify_backups.ps1`)
- Weekly restore test (see `scripts/maintenance/test_restore.ps1`)
- Monthly full DR drill (see [drill-schedule.md](drill-schedule.md))

## Failover Procedures

1. Detect failure via health check (`/health`, `/ready`, `/live`)
2. Promote standby replica
3. Update DNS / load balancer
4. Verify traffic routing
5. Post-failover validation

## Quarterly Drills

- Q1: Database failover drill
- Q2: Full region failover drill
- Q3: Backup restore validation
- Q4: End-to-end DR exercise

## Dependencies

See [[OPS-MAN-201] dependencies](../OPS-MAN/[OPS-MAN-201] dependencies.md) for critical service dependency map.

## Related

- [../incident-runbooks/00_INDEX_事件响应剧本-总目录.md](../incident-runbooks/00_INDEX_事件响应剧本-总目录.md) - incident response runbooks
- [[OPS-MAN-202] oncall](../OPS-MAN/[OPS-MAN-202] oncall.md) - oncall schedule
