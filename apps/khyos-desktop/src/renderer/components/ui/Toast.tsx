import { useEffect, useState } from 'react'

interface ToastProps {
  message: string
  type?: 'info' | 'success' | 'warning' | 'error'
  duration?: number
  onClose?: () => void
}

export function Toast({ message, type = 'info', duration = 3000, onClose }: ToastProps) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false)
      setTimeout(() => onClose?.(), 200)
    }, duration)
    return () => clearTimeout(timer)
  }, [duration, onClose])

  const typeConfig = {
    info: { bg: 'bg-toast', border: 'border-border', icon: 'ℹ️' },
    success: { bg: 'bg-success/10', border: 'border-success/30', icon: '✅' },
    warning: { bg: 'bg-warning/10', border: 'border-warning/30', icon: '⚠️' },
    error: { bg: 'bg-destructive/10', border: 'border-destructive/30', icon: '❌' },
  }

  const config = typeConfig[type]

  return (
    <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border shadow-xl ${config.bg} ${config.border} transition-all duration-200 ${
      visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
    }`}>
      <span className="text-sm">{config.icon}</span>
      <span className="text-sm text-foreground">{message}</span>
    </div>
  )
}

export function ToastContainer({ toasts, onRemove }: { toasts: { id: string; message: string; type?: 'info' | 'success' | 'warning' | 'error' }[]; onRemove: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map(toast => (
        <Toast key={toast.id} message={toast.message} type={toast.type} onClose={() => onRemove(toast.id)} />
      ))}
    </div>
  )
}
