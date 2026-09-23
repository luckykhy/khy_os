/**
 * useDashboardHandover.test.js — 锁 src/composables/useDashboardHandover.js 的
 * 交接快照契约：摘要归一（缺省补 0 / 非对象回退）、保留变更截断 5 条、
 * loadHandoverSnapshot 的成功 / 业务失败 / 网络异常 / 失败提示 / 并发排队
 * （allowQueue 默认 true，首请求完成后自动触发 queued_refresh）。
 * 不触真实网络：mock @/api/largeTasks 与 @/config/api。
 * 注：SSE 通道状态机（channelState/reconnect）依赖内部 ref，超出公共
 * 暴露面，本轮不锁，留待下夜用 mount 级测试补。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getHandoverSnapshot: vi.fn(),
  getApiBaseUrl: vi.fn(() => '/api'),
  ElMessage: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

vi.mock('@/api/largeTasks', () => ({ getHandoverSnapshot: mocks.getHandoverSnapshot }))
vi.mock('@/config/api', () => ({ getApiBaseUrl: mocks.getApiBaseUrl }))
vi.mock('element-plus', () => ({ ElMessage: mocks.ElMessage }))

import { useDashboardHandover } from '@/composables/useDashboardHandover'

const EMPTY_SUMMARY = {
  recent_operation_count: 0,
  retention_policy_change_count: 0,
  active_large_task_count: 0,
  pending_todo_count: 0,
  pending_remote_approval_count: 0,
  active_remote_session_count: 0,
  queue_depth: 0
}

function snapshotResponse(summary, extra) {
  return { success: true, data: { snapshot: { summary, ...extra } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getApiBaseUrl.mockReturnValue('/api')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('摘要与保留变更（computed 归一）', () => {
  it('无快照时摘要为全零对象', () => {
    const h = useDashboardHandover()
    expect(h.handoverSummary.value).toEqual(EMPTY_SUMMARY)
  })

  it('有快照时摘要逐字段归一（缺省补 0）', () => {
    const h = useDashboardHandover()
    h.handoverSnapshot.value = { summary: { active_large_task_count: 3 } }
    const s = h.handoverSummary.value
    expect(s.active_large_task_count).toBe(3)
    expect(s.queue_depth).toBe(0)
    expect(s).not.toEqual(EMPTY_SUMMARY)
  })

  it('summary 为 null / 非对象时回退全零', () => {
    const h = useDashboardHandover()
    h.handoverSnapshot.value = { summary: null }
    expect(h.handoverSummary.value).toEqual(EMPTY_SUMMARY)
    h.handoverSnapshot.value = { summary: 'garbage' }
    expect(h.handoverSummary.value).toEqual(EMPTY_SUMMARY)
  })

  it('recentRetentionChanges 截断为前 5 条；非数组返回 []', () => {
    const h = useDashboardHandover()
    h.handoverSnapshot.value = { recent_retry_policy_approval_retention_changes: [1, 2, 3, 4, 5, 6] }
    expect(h.recentRetentionChanges.value).toEqual([1, 2, 3, 4, 5])
    h.handoverSnapshot.value = { recent_retry_policy_approval_retention_changes: 'x' }
    expect(h.recentRetentionChanges.value).toEqual([])
  })
})

describe('loadHandoverSnapshot', () => {
  it('成功：写入快照；showSuccessMessage 时提示；loading 归零', async () => {
    const h = useDashboardHandover()
    mocks.getHandoverSnapshot.mockResolvedValue(snapshotResponse({ active_large_task_count: 1 }))
    await h.loadHandoverSnapshot(true)
    expect(h.handoverSnapshot.value.summary.active_large_task_count).toBe(1)
    expect(mocks.ElMessage.success).toHaveBeenCalledTimes(1)
    expect(mocks.ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('跨设备交接快照已刷新'))
    expect(h.handoverLoading.value).toBe(false)
    expect(h.handoverError.value).toBe('')
  })

  it('按固定窗口参数请求快照', async () => {
    const h = useDashboardHandover()
    mocks.getHandoverSnapshot.mockResolvedValue(snapshotResponse({}))
    await h.loadHandoverSnapshot()
    expect(mocks.getHandoverSnapshot).toHaveBeenCalledWith({
      window_minutes: 60,
      operation_limit: 5,
      retention_limit: 5,
      running_limit: 20,
      todo_limit: 10,
      approval_limit: 10,
      session_limit: 10
    })
  })

  it('success=false：fail-soft 记录 handoverError，不抛到调用方', async () => {
    const h = useDashboardHandover()
    mocks.getHandoverSnapshot.mockResolvedValue({ success: false, message: '后端未就绪' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(h.loadHandoverSnapshot(false, { trigger: 'sse' })).resolves.toBeUndefined()
    expect(h.handoverError.value).toBe('后端未就绪')
  })

  it('网络异常：记录 error.message', async () => {
    const h = useDashboardHandover()
    mocks.getHandoverSnapshot.mockRejectedValue(new Error('连接中断'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(h.loadHandoverSnapshot()).resolves.toBeUndefined()
    expect(h.handoverError.value).toBe('连接中断')
  })

  it('showSuccessMessage 在失败路径提示 ElMessage.error（含问题文案）', async () => {
    const h = useDashboardHandover()
    mocks.getHandoverSnapshot.mockRejectedValue(new Error('timeout'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await h.loadHandoverSnapshot(true)
    expect(mocks.ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('刷新交接快照失败'))
    expect(mocks.ElMessage.error.mock.calls[0][0]).toContain('timeout')
  })

  it('加载中并发调用走排队，首请求完成后自动触发 queued_refresh', async () => {
    const h = useDashboardHandover()
    let release
    mocks.getHandoverSnapshot.mockImplementationOnce(() => new Promise((r) => { release = r }))
    const p1 = h.loadHandoverSnapshot(false, { trigger: 'manual' })
    // 第二次调用（默认 allowQueue=true）应挂起排队（pending），而非立即 resolve
    const p2 = h.loadHandoverSnapshot(false, { trigger: 'sse' })
    expect(p2).toBeInstanceOf(Promise)
    release(snapshotResponse({}))
    await p1
    // queued_refresh 由 finally 触发，等一个微任务 + 短延时
    await new Promise((r) => setTimeout(r, 30))
    expect(mocks.getHandoverSnapshot).toHaveBeenCalledTimes(2)
    await p2
  })
})
