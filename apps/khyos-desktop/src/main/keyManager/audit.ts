// audit — append-only audit trail for the Key/Endpoint Manager (spec §7.1/§7.2).
//
// Single new file (allowed fourth artifact, spec §4.2): key_manager_audit.jsonl
// under dataHome. Lines are JSON: {ts, op, target?, fingerprint?, detail?}.
// Hard rule: this module NEVER accepts or writes a plaintext key — only
// sha256-8 fingerprints. Callers pass pre-masked metadata.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { AUDIT_FILE } from './types.ts'
import type { AuditEntry } from './types.ts'
import { getDataHome } from './keyStore.ts'

export function auditPath(): string {
  return path.join(getDataHome(), AUDIT_FILE)
}

export async function appendAudit(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  const file = auditPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  // POSIX best-effort 0600 (no-op on Windows); keep append so concurrent
  // writers (main process only in P1) cannot truncate history.
  await fs.appendFile(file, `${line}\n`, 'utf-8')
  try {
    if (process.platform !== 'win32') await fs.chmod(file, 0o600)
  } catch {
    /* best-effort */
  }
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  const file = auditPath()
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return []
  }
  const lines = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(-limit)
  const out: AuditEntry[] = []
  for (const l of lines) {
    try {
      out.push(JSON.parse(l) as AuditEntry)
    } catch {
      /* skip torn line (never fatal for a read-only view) */
    }
  }
  return out
}

export async function exportAudit(destFile: string): Promise<{ ok: boolean; count: number; error?: string }> {
  const entries = await listAudit(10_000)
  try {
    await fs.mkdir(path.dirname(path.resolve(destFile)), { recursive: true })
    await fs.writeFile(destFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
    return { ok: true, count: entries.length }
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

// test seam
export function _auditFile(): string {
  return auditPath()
}
