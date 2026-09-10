import { useState, useRef, useEffect } from 'react'

interface TooltipProps {
  content: string
  children: React.ReactNode
  position?: 'top' | 'bottom' | 'left' | 'right'
  delay?: number
}

export function Tooltip({ content, children, position = 'top', delay = 300 }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState({ x: 0, y: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>()

  const show = () => {
    timeoutRef.current = setTimeout(() => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top
        setCoords({ x, y })
      }
      setVisible(true)
    }, delay)
  }

  const hide = () => {
    clearTimeout(timeoutRef.current)
    setVisible(false)
  }

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current)
  }, [])

  const positionClass = {
    top: 'bottom-full mb-2 left-1/2 -translate-x-1/2',
    bottom: 'top-full mt-2 left-1/2 -translate-x-1/2',
    left: 'right-full mr-2 top-1/2 -translate-y-1/2',
    right: 'left-full ml-2 top-1/2 -translate-y-1/2',
  }

  return (
    <div ref={triggerRef} onMouseEnter={show} onMouseLeave={hide} className="relative inline-flex">
      {children}
      {visible && (
        <div
          ref={tooltipRef}
          className={`absolute z-50 px-2.5 py-1.5 text-xs font-medium text-popover-foreground bg-popover border border-popover-border rounded-lg shadow-lg whitespace-nowrap pointer-events-none animate-fade-in ${positionClass[position]}`}
        >
          {content}
        </div>
      )}
    </div>
  )
}
