# KHY Mobile Contracts

This directory contains JSON Schemas for KHY's mobile-safe agent protocol.

## Schemas

- `approval-ticket.schema.json`
  - High-risk operation approval ticket contract.
  - Used when risky operations are blocked pending explicit user confirmation.
- `mobile-stream-event.schema.json`
  - Stream event envelope for mobile rendering.
  - Supports status updates, batch-step progress, diff preview, test result, approval cards, handover snapshots, and final summaries.
- `device-handover-snapshot.schema.json`
  - Cross-device session handover snapshot contract.
  - Includes recent actions, running background tasks, pending approvals, and todos.

## Versioning

- Current contract version: `1.0`
- Backward-incompatible changes must bump the version and provide migration notes.

## Integration Notes

- Always set `redaction_applied=true` before payload leaves local device boundary.
- Keep mobile payload concise; avoid sending full source files or raw secrets.
- `severity` is normalized for UI mapping:
  - `ok`, `warn`, `wait`, `error`, `info`

