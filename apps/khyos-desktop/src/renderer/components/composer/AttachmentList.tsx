import { useState } from 'react'

type AttachmentStatus = 'queued' | 'uploading' | 'finishing' | 'completed' | 'failed' | 'retrying'

interface Attachment {
  id: string
  name: string
  size: number
  type: 'image' | 'pdf' | 'video' | 'text' | 'file'
  status: AttachmentStatus
  progress: number
  error?: string
}

const statusConfig: Record<AttachmentStatus, { label: string; color: string; icon: string }> = {
  queued: { label: '排队中', color: 'text-foreground/40', icon: '⏳' },
  uploading: { label: '上传中', color: 'text-brand', icon: '⬆️' },
  finishing: { label: '正在完成上传', color: 'text-brand', icon: '🔄' },
  completed: { label: '上传完成', color: 'text-success', icon: '✅' },
  failed: { label: '上传失败', color: 'text-destructive', icon: '❌' },
  retrying: { label: '重试上传', color: 'text-warning', icon: '🔄' },
}

const typeIcons: Record<string, string> = {
  image: '🖼️',
  pdf: '📄',
  video: '🎬',
  text: '📝',
  file: '📎',
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function AttachmentList({ attachments, onRemove, onRetry }: {
  attachments: Attachment[]
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}) {
  if (attachments.length === 0) return null

  return (
    <div className="mb-3 space-y-2">
      {attachments.map(att => {
        const status = statusConfig[att.status]
        return (
          <div key={att.id} className="flex items-center gap-3 p-3 bg-card border border-card-border rounded-xl">
            <span className="text-lg">{typeIcons[att.type] || '📎'}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground truncate">{att.name}</span>
                <span className="text-xs text-foreground/30">{formatSize(att.size)}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className={`text-xs ${status.color}`}>
                  {status.icon} {status.label}
                </span>
                {att.status === 'uploading' && (
                  <span className="text-xs text-foreground/40">{att.progress}%</span>
                )}
                {att.error && (
                  <span className="text-xs text-destructive">{att.error}</span>
                )}
              </div>
              {att.status === 'uploading' && (
                <div className="mt-2 h-1.5 bg-surface rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand rounded-full transition-all duration-300"
                    style={{ width: `${att.progress}%` }}
                  />
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              {att.status === 'failed' && (
                <button
                  onClick={() => onRetry(att.id)}
                  className="px-2.5 py-1 text-xs text-warning border border-warning/30 rounded-lg hover:bg-warning/10 transition-colors"
                >
                  重试
                </button>
              )}
              <button
                onClick={() => onRemove(att.id)}
                className="p-1.5 text-foreground/40 hover:text-destructive hover:bg-surface-hover rounded-lg transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function AttachmentDemo() {
  const [attachments, setAttachments] = useState<Attachment[]>([
    { id: '1', name: 'screenshot.png', size: 245000, type: 'image', status: 'completed', progress: 100 },
    { id: '2', name: 'document.pdf', size: 1024000, type: 'pdf', status: 'uploading', progress: 65 },
    { id: '3', name: 'notes.txt', size: 5000, type: 'text', status: 'failed', progress: 0, error: '网络超时' },
  ])

  return (
    <div className="p-4">
      <h3 className="text-sm font-medium text-foreground mb-3">附件列表</h3>
      <AttachmentList
        attachments={attachments}
        onRemove={id => setAttachments(prev => prev.filter(a => a.id !== id))}
        onRetry={id => setAttachments(prev => prev.map(a => a.id === id ? { ...a, status: 'retrying' as const, progress: 0 } : a))}
      />
    </div>
  )
}
