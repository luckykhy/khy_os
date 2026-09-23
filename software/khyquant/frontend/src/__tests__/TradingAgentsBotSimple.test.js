// TradingAgentsBotSimple.test.js — 锁多智能体分析助手组件
// 锁：可见性/展开状态、智能体启停、股票校验、分析 API 接线与结果组装
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { shallowMount } from '@vue/test-utils'

vi.mock('@/utils/request', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('element-plus', () => ({
  ElMessage: Object.assign(vi.fn(), {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  }),
  ElNotification: vi.fn(),
  ElMessageBox: { confirm: vi.fn(), prompt: vi.fn() }
}))

import request from '@/utils/request'
import { ElMessage, ElNotification } from 'element-plus'
import TradingAgentsBotSimple from '@/components/TradingAgentsBotSimple.vue'

function mountBot() {
  return shallowMount(TradingAgentsBotSimple, {
    props: {},
    global: { stubs: { ChannelHealthIndicator: true } }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.removeItem('ai-assistant-visible')
  request.post.mockResolvedValue({ success: true, data: {} })
})
afterEach(() => {
  localStorage.removeItem('ai-assistant-visible')
})

describe('渲染与可见性', () => {
  it('默认可见，渲染浮动机器人并显示 5 个激活智能体计数', () => {
    const wrapper = mountBot()
    expect(wrapper.find('.trading-agents-bot').exists()).toBe(true)
    expect(wrapper.find('.agent-count').text()).toBe('5')
    expect(wrapper.find('.bot-avatar').exists()).toBe(true)
    wrapper.unmount()
  })

  it('localStorage 标记隐藏时不渲染', () => {
    localStorage.setItem('ai-assistant-visible', 'false')
    const wrapper = mountBot()
    expect(wrapper.find('.trading-agents-bot').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hideAssistant 隐藏机器人并持久化状态', async () => {
    const wrapper = mountBot()
    wrapper.vm.hideAssistant()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.trading-agents-bot').exists()).toBe(false)
    expect(localStorage.getItem('ai-assistant-visible')).toBe('false')
    expect(ElMessage.success).toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('智能体启停', () => {
  it('默认 5 个激活，策略分析师默认停用', () => {
    const wrapper = mountBot()
    const active = wrapper.vm.activeAgents.map((a) => a.id)
    expect(active).toEqual(['market', 'technical', 'fundamentals', 'news', 'risk'])
    wrapper.unmount()
  })

  it('toggleAgent 启停智能体并提示', () => {
    const wrapper = mountBot()
    wrapper.vm.toggleAgent('strategy')
    expect(wrapper.vm.activeAgents).toHaveLength(6)
    expect(ElMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: '策略分析师 已启用', type: 'success' })
    )
    wrapper.vm.toggleAgent('market')
    expect(wrapper.vm.activeAgents).toHaveLength(5)
    expect(wrapper.vm.activeAgents.map((a) => a.id)).not.toContain('market')
    wrapper.unmount()
  })

  it('分析进行中不允许切换智能体', () => {
    const wrapper = mountBot()
    wrapper.vm.isThinking = true
    const before = wrapper.vm.activeAgents.length
    wrapper.vm.toggleAgent('market')
    expect(wrapper.vm.activeAgents.length).toBe(before)
    wrapper.unmount()
  })
})

describe('股票代码校验', () => {
  it('validateStockCode：非空即有效', () => {
    const wrapper = mountBot()
    expect(wrapper.vm.isValidStockCode).toBe(false)
    wrapper.vm.stockCode = 'sh000300'
    wrapper.vm.validateStockCode()
    expect(wrapper.vm.isValidStockCode).toBe(true)
    wrapper.unmount()
  })

  it('selectStock 填充代码并完成校验', () => {
    const wrapper = mountBot()
    wrapper.vm.selectStock('sh600519')
    expect(wrapper.vm.stockCode).toBe('sh600519')
    expect(wrapper.vm.isValidStockCode).toBe(true)
    wrapper.unmount()
  })
})

describe('分析流程（/trading-agents/analyze 接线）', () => {
  it('有效代码 + 已选智能体：调用后端分析接口并组装结果', async () => {
    const wrapper = mountBot()
    wrapper.vm.selectStock('sh000300')
    await wrapper.vm.startAnalysis()
    expect(request.post).toHaveBeenCalledTimes(1)
    const [url, body] = request.post.mock.calls[0]
    expect(url).toBe('/trading-agents/analyze')
    expect(body.symbol).toBe('sh000300')
    expect(body.useML).toBe(true)
    // 前端短名 → 后端全名映射
    expect(body.context.enabledAgents).toEqual([
      'market_analyst',
      'technical_analyst',
      'fundamental_analyst',
      'news_analyst',
      'risk_analyst'
    ])
    // 结果组装：无 agentResults 时为每个激活智能体生成基础结果
    const result = wrapper.vm.analysisResult
    expect(result.stockCode).toBe('sh000300')
    expect(result.agentResults).toHaveLength(5)
    expect(result.recommendation).toBe('持有')
    expect(result.confidence).toBe(50)
    expect(wrapper.vm.analysisHistory).toHaveLength(1)
    expect(wrapper.vm.isThinking).toBe(false)
    expect(ElMessage.success).toHaveBeenCalledWith('TradingAgents分析完成！')
    wrapper.unmount()
  })

  it('无效代码时不调用接口并提示', async () => {
    const wrapper = mountBot()
    await wrapper.vm.startAnalysis()
    expect(request.post).not.toHaveBeenCalled()
    expect(ElMessage.warning).toHaveBeenCalledWith('请输入有效的股票代码')
    wrapper.unmount()
  })

  it('后端失败时降级本地模拟分析：通知切换、结果标记本地模式', async () => {
    request.post.mockRejectedValueOnce(new Error('boom'))
    const wrapper = mountBot()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    wrapper.vm.selectStock('sh000300')
    vi.useFakeTimers()
    try {
      const p = wrapper.vm.startAnalysis()
      // 降级 simulateAnalysis 内含 1s+2s+1s 的延时动画，用假计时器推进
      await vi.advanceTimersByTimeAsync(5000)
      await p
      expect(ElNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: '分析模式切换', type: 'warning' })
      )
      const result = wrapper.vm.analysisResult
      expect(result.isRealLLM).toBe(false)
      expect(result.aiProvider).toBe('本地模拟')
      expect(result.agentResults.length).toBe(5)
      expect(wrapper.vm.isThinking).toBe(false)
      expect(ElMessage.error).not.toHaveBeenCalledWith('分析失败，请稍后重试')
    } finally {
      vi.useRealTimers()
    }
    wrapper.unmount()
  })

  it('后端返回 agentResults 时按映射过滤用户选中的智能体', async () => {
    request.post.mockResolvedValueOnce({
      success: true,
      data: {
        agentResults: [
          { agentId: 'market_analyst', agentName: '市场分析师', score: '8', analysis: 'x', algorithm: 'RF', keyFindings: ['f1'] },
          { agentId: 'strategy_analyst', agentName: '策略分析师', score: '8', analysis: 'x' }
        ]
      }
    })
    const wrapper = mountBot()
    wrapper.vm.selectStock('sh000001')
    await wrapper.vm.startAnalysis()
    const result = wrapper.vm.analysisResult
    // strategy 未激活 → 被过滤
    const ids = result.agentResults.map((r) => r.agentId)
    expect(ids).toContain('market')
    expect(ids).not.toContain('strategy')
    // 后端没有覆盖的智能体补基础结果
    expect(result.agentResults.filter((r) => r.score === '7.5').length).toBeGreaterThanOrEqual(4)
    expect(ElNotification).toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('面板操作', () => {
  it('togglePanel 展开/收起；close/minimize 收起', () => {
    const wrapper = mountBot()
    expect(wrapper.vm.isExpanded).toBe(false)
    wrapper.vm.togglePanel()
    expect(wrapper.vm.isExpanded).toBe(true)
    wrapper.vm.closePanel()
    expect(wrapper.vm.isExpanded).toBe(false)
    wrapper.vm.togglePanel()
    wrapper.vm.minimizePanel()
    expect(wrapper.vm.isExpanded).toBe(false)
    wrapper.unmount()
  })

  it('非拖拽状态下 togglePanel 才生效', () => {
    const wrapper = mountBot()
    wrapper.vm.isDragging = true
    wrapper.vm.togglePanel()
    expect(wrapper.vm.isExpanded).toBe(false)
    wrapper.unmount()
  })

  it('整体进度：未分析时为 0，状态 normal', () => {
    const wrapper = mountBot()
    expect(wrapper.vm.overallProgress).toBe(0)
    expect(wrapper.vm.progressStatus).toBe('normal')
    wrapper.unmount()
  })
})
