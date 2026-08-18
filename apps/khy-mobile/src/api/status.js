export function operationStatus(action, target, progress, tone = 'info') {
  return { action: String(action), target: String(target), progress: String(progress), tone };
}

export function statusText(status) {
  if (!status) return '';
  return `${status.action} · ${status.target} · ${status.progress}`;
}
