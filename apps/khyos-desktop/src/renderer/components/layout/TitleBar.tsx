import { useState, useEffect } from 'react'

const TITLEBAR_HEIGHT = 48
const CAPTION_BUTTON_WIDTH = 46

export function TitleBar() {
  const [platform, setPlatform] = useState('win32')

  useEffect(() => {
    const api = (window as any).__KHYOS__
    if (api) setPlatform(api.getPlatform())
  }, [])

  const isMac = platform === 'darwin'

  return (
    <div
      className="bg-header flex items-center select-none"
      style={{ height: TITLEBAR_HEIGHT, WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="flex-1 px-4 text-sm text-foreground truncate" style={{ paddingLeft: isMac ? 76 : 16 }}>
        KhyOS Desktop
      </div>
      {!isMac && (
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={() => (window as any).__KHYOS__?.minimizeWindow()} className="flex items-center justify-center hover:bg-surface-hover text-foreground" style={{ width: CAPTION_BUTTON_WIDTH, height: TITLEBAR_HEIGHT }} aria-label="最小化窗口">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6H10" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
          <button onClick={() => (window as any).__KHYOS__?.maximizeWindow()} className="flex items-center justify-center hover:bg-surface-hover text-foreground" style={{ width: CAPTION_BUTTON_WIDTH, height: TITLEBAR_HEIGHT }} aria-label="最大化或还原窗口">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
          </button>
          <button onClick={() => (window as any).__KHYOS__?.closeWindow()} className="flex items-center justify-center hover:bg-destructive text-foreground" style={{ width: CAPTION_BUTTON_WIDTH, height: TITLEBAR_HEIGHT }} aria-label="关闭">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
        </div>
      )}
    </div>
  )
}
