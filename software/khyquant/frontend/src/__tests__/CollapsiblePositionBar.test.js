// CollapsiblePositionBar.test.js — 锁持仓栏组件行为
// 锁：props 渲染、事件 emit、盈利/风险计算、委托单拉取与撤单 API 接线
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@/utils/request', () => ({ default: { get: vi.fn(), post: vi.fn() } }))
vi.mock('element-plus', () => ({
  ElMessage: Object.assign(vi.fn(), { success: vi.fn() }),
  ElMessageBox: { confirm: vi.fn() }
}))

import request from '@/utils/request'
import { ElMessageBox, ElMessage } from 'element-plus'
import CollapsiblePositionBar from '@/components/CollapsiblePositionBar.vue'

const positions = () => [
  { id: 1, symbol: '600519', name: '贵州茅台', direction: 'long', isFutures: false, avgPrice: 10, quantity: 10, profit: 100, profitPercent: 2.5 },
  { id: 2, symbol: 'rb2510', name: '螺纹钢', direction: 'short', isFutures: true, avgPrice: 3300, quantity: 1, profit: 50, profitPercent: 0.15 }
]

function mountBar(props = {}) {
  return mount(CollapsiblePositionBar, {
    props: {
      positions: positions(),
      availableFunds: 100000,
      currentPrices: {},
      ...props
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  request.get.mockResolvedValue({ data: [] })
  ElMessageBox.confirm.mockResolvedValue('confirm')
})

describe('props 渲染', () => {
  it('初始收起状态：面板隐藏，触发按钮显示持仓数量', () => {
    const wrapper = mountBar()
    expect(wrapper.find('.position-panel').exists()).toBe(false)
    expect(wrapper.find('.debug-info').text()).toContain('收起')
    expect(wrapper.find('.position-trigger-btn').classes()).not.toContain('active')
    wrapper.unmount()
  })

  it('点击触发按钮展开面板并激活样式', async () => {
    const wrapper = mountBar()
    await wrapper.find('.position-trigger-btn').trigger('click')
    expect(wrapper.find('.position-panel').exists()).toBe(true)
    expect(wrapper.find('.debug-info').text()).toContain('展开')
    expect(wrapper.find('.position-trigger-btn').classes()).toContain('active')
    wrapper.unmount()
  })

  it('期货持仓显示风险率，样式类随阈值变化', async () => {
    const wrapper = mountBar()
    await wrapper.find('.position-trigger-btn').trigger('click')
    const riskText = wrapper.find('.risk-rate .value').text()
    // 保证金 = 3300*1*0.15 = 495；495/100000*100 = 0.495% → risk-low
    expect(riskText).toBe('0.50%')
    expect(wrapper.find('.risk-rate .value').classes()).toContain('risk-low')
    wrapper.unmount()

    const high = mountBar({ availableFunds: 400 })
    await high.find('.position-trigger-btn').trigger('click')
    expect(high.find('.risk-rate .value').text()).toBe('123.75%')
    expect(high.find('.risk-rate .value').classes()).toContain('risk-high')
    high.unmount()
  })

  it('总浮动盈亏与百分比正确展示', async () => {
    const wrapper = mountBar()
    await wrapper.find('.position-trigger-btn').trigger('click')
    // 总盈亏 100+50=150；总成本 10*10 + 3300*1 = 3400 → 4.41%
    expect(wrapper.find('.total-profit .amount').text()).toBe('150.00')
    expect(wrapper.find('.profit-percent').text()).toBe('+4.41%')
    expect(wrapper.find('.profit-value').classes()).toContain('profit-positive')
    wrapper.unmount()
  })

  it('期货多空方向文案与样式', async () => {
    const wrapper = mountBar({
      positions: [
        { ...positions()[1], direction: 'long' },
        { ...positions()[0], direction: 'short' }
      ]
    })
    await wrapper.find('.position-trigger-btn').trigger('click')
    const tags = wrapper.findAll('.direction-tag')
    expect(tags[0].text()).toBe('多')
    expect(tags[0].classes()).toContain('direction-long')
    expect(tags[1].text()).toBe('持有')
    expect(tags[1].classes()).toContain('direction-hold')
    wrapper.unmount()
  })

  it('无持仓时显示空态提示', async () => {
    const wrapper = mountBar({ positions: [] })
    await wrapper.find('.position-trigger-btn').trigger('click')
    expect(wrapper.find('.empty-positions').text()).toContain('暂无持仓')
    wrapper.unmount()
  })
})

describe('事件 emit', () => {
  it('点击持仓卡片 emit select-position', async () => {
    const wrapper = mountBar()
    await wrapper.find('.position-trigger-btn').trigger('click')
    const card = wrapper.findAll('.position-card')[1]
    await card.trigger('click')
    expect(wrapper.emitted('select-position')).toHaveLength(1)
    expect(wrapper.emitted('select-position')[0][0]).toMatchObject({ id: 2, symbol: 'rb2510' })
    wrapper.unmount()
  })

  it('平仓确认成功后 emit close-position，取消则不 emit', async () => {
    const wrapper = mountBar()
    await wrapper.find('.position-trigger-btn').trigger('click')
    await wrapper.findAll('.position-card .close-btn')[0].trigger('click')
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close-position')).toHaveLength(1)
    expect(wrapper.emitted('close-position')[0][0]).toMatchObject({ id: 1 })
    wrapper.unmount()

    ElMessageBox.confirm.mockRejectedValueOnce('cancel')
    const w2 = mountBar()
    await w2.find('.position-trigger-btn').trigger('click')
    await w2.findAll('.position-card .close-btn')[0].trigger('click')
    expect(w2.emitted('close-position')).toBeUndefined()
    w2.unmount()
  })
})

describe('委托单（pending orders）接线', () => {
  it('挂载即拉取 /trading/pending，数据渲染徽标与列表', async () => {
    request.get.mockResolvedValue({ data: [{ id: 77, symbol: 'sh600519', side: 'buy', price: '10.5', quantity: 100, createdAt: '2024-06-01T09:30:00' }] })
    const wrapper = mountBar()
    await vi.waitFor(() => expect(wrapper.find('.pending-badge').exists()).toBe(true))
    expect(request.get).toHaveBeenCalledWith('/trading/pending')
    expect(wrapper.find('.pending-badge').text()).toBe('1')
    // 切到委托 Tab
    await wrapper.find('.position-trigger-btn').trigger('click')
    const tabs = wrapper.findAll('.tab-btn')
    await tabs[1].trigger('click')
    expect(wrapper.find('.pending-order-card').exists()).toBe(true)
    expect(wrapper.find('.pending-order-card .symbol-code').text()).toBe('sh600519')
    expect(wrapper.find('.order-type-tag').classes()).toContain('tag-buy')
    wrapper.unmount()
  })

  it('撤单：确认后 POST /trading/cancel/:id 并提示成功', async () => {
    request.get.mockResolvedValue({ data: [{ id: 88, symbol: 'sh000001', side: 'sell', price: 11, quantity: 200 }] })
    const wrapper = mountBar()
    await vi.waitFor(() => expect(request.get).toHaveBeenCalled())
    await wrapper.find('.position-trigger-btn').trigger('click')
    await wrapper.findAll('.tab-btn')[1].trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.pending-order-card').exists()).toBe(true))
    await wrapper.find('.cancel-btn').trigger('click')
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(request.post).toHaveBeenCalledWith('/trading/cancel/88'))
    expect(ElMessage.success).toHaveBeenCalledWith('Order cancelled')
    wrapper.unmount()
  })

  it('撤单取消时不发请求', async () => {
    ElMessageBox.confirm.mockRejectedValueOnce('cancelled')
    request.get.mockResolvedValue({ data: [{ id: 89, symbol: 'sh000001', side: 'buy', price: 1, quantity: 1 }] })
    const wrapper = mountBar()
    await vi.waitFor(() => expect(request.get).toHaveBeenCalled())
    await wrapper.find('.position-trigger-btn').trigger('click')
    await wrapper.findAll('.tab-btn')[1].trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.cancel-btn').exists()).toBe(true))
    await wrapper.find('.cancel-btn').trigger('click')
    await new Promise((r) => setTimeout(r, 20))
    expect(request.post).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('持仓数据深监听（更新高亮）', () => {
  it('盈亏变化时卡片临时高亮，500ms 后移除', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountBar()
      await wrapper.find('.position-trigger-btn').trigger('click')
      const changed = positions()
      changed[0] = { ...changed[0], profit: 999 }
      await wrapper.setProps({ positions: changed })
      await vi.advanceTimersByTimeAsync(0)
      expect(wrapper.findAll('.position-card')[0].classes()).toContain('highlight')
      await vi.advanceTimersByTimeAsync(500)
      expect(wrapper.findAll('.position-card')[0].classes()).not.toContain('highlight')
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
