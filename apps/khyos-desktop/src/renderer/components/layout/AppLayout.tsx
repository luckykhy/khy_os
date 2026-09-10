import { useState, useCallback } from 'react'
import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { SidePane } from './SidePane'
import { StatusBar } from './StatusBar'

interface AppLayoutProps {
  children: React.ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  const [activePanel, setActivePanel] = useState('tasks')
  const [sidePaneVisible, setSidePaneVisible] = useState(false)
  const [sidePaneTab, setSidePaneTab] = useState('files')
  const [activeTaskId, setActiveTaskId] = useState<string | null>('sess_001')
  const [viewMode, setViewMode] = useState<'grouped' | 'chronological'>('grouped')
  const [searchQuery, setSearchQuery] = useState('')

  const handlePanelChange = useCallback((panel: string) => {
    if (panel === 'files' || panel === 'terminal' || panel === 'git') {
      setSidePaneTab(panel)
      setSidePaneVisible(true)
    }
    setActivePanel(panel)
  }, [])

  const handleSidePaneClose = useCallback(() => {
    setSidePaneVisible(false)
  }, [])

  return (
    <div className="flex flex-col h-screen bg-background">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar activePanel={activePanel} onPanelChange={handlePanelChange} />
        <WorkspaceSidebar
          tasks={[
            { id: 'sess_001', title: '实现登录功能', workspacePath: 'D:\\Portable\\khy-os', createdAt: Date.now() - 86400000, updatedAt: Date.now() - 3600000, archived: false },
            { id: 'sess_002', title: '修复终端渲染问题', workspacePath: 'D:\\Portable\\khy-os', createdAt: Date.now() - 172800000, updatedAt: Date.now() - 7200000, archived: false },
            { id: 'sess_003', title: '添加单元测试', workspacePath: 'D:\\Portable\\khy-os', createdAt: Date.now() - 259200000, updatedAt: Date.now() - 86400000, archived: false },
          ]}
          archivedTasks={[
            { id: 'sess_arch_001', title: '初始化项目结构', workspacePath: 'D:\\Portable\\khy-os', createdAt: Date.now() - 604800000, updatedAt: Date.now() - 432000000, archived: true },
            { id: 'sess_arch_002', title: '配置 CI/CD 流水线', workspacePath: 'D:\\Portable\\khy-os', createdAt: Date.now() - 1209600000, updatedAt: Date.now() - 1036800000, archived: true },
          ]}
          activeTaskId={activeTaskId}
          onTaskSelect={setActiveTaskId}
          onNewTask={() => console.log('[workspace] new task')}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
        <main className="flex-1 overflow-auto flex flex-col">{children}</main>
        <SidePane
          visible={sidePaneVisible}
          activeTab={sidePaneTab}
          onTabChange={setSidePaneTab}
          onClose={handleSidePaneClose}
        />
      </div>
      <StatusBar model="GLM-5.3Max" mode="默认模式" contextUsage={{ used: 12400, total: 128000 }} status="idle" />
    </div>
  )
}
