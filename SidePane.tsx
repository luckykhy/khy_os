import { useState, useEffect } from 'react'
import { TerminalPanel } from '../terminal/Terminal'
import { FileTree } from '../filetree/FileTree'
import { GitPanel } from '../git/GitPanel'

export function SidePane() {
  const [visible, setVisible] = useState(false)
  const [activeTab, setActiveTab] = useState('files')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key === 'b') { e.preventDefault(); setVisible(v => !v) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  if (!visible) return null

  return (
    <div className="bg-panel w-80 border-l border-border flex flex-col h-full">
      <div className="flex border-b border-border">
        <button onClick={() => setActiveTab('files')} className={'px-3 py-2 text-sm ' + (activeTab === 'files' ? 'text-foreground border-b-2 border-brand' : 'text-foreground hover:bg-surface-hover')}>文件</button>
        <button onClick={() => setActiveTab('terminal')} className={'px-3 py-2 text-sm ' + (activeTab === 'terminal' ? 'text-foreground border-b-2 border-brand' : 'text-foreground hover:bg-surface-hover')}>终端</button>
        <button onClick={() => setActiveTab('git')} className={'px-3 py-2 text-sm ' + (activeTab === 'git' ? 'text-foreground border-b-2 border-brand' : 'text-foreground hover:bg-surface-hover')}>Git</button>
      </div>
      <div className="flex-1 overflow-auto">
        {activeTab === 'files' && <FileTree />}
        {activeTab === 'terminal' && <TerminalPanel />}
        {activeTab === 'git' && <GitPanel />}
      </div>
    </div>
  )
}
