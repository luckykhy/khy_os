import request from '@/api/request'

/**
 * 获取跨设备交接快照
 * @param {Object} params - 查询参数
 * @returns {Promise<Object>}
 */
export function getHandoverSnapshot(params = {}) {
  return request({
    url: '/large-tasks/handover/snapshot',
    method: 'get',
    params,
    silentLoading: true
  })
}

/**
 * 获取移动端紧凑快照
 * @param {Object} params - 查询参数
 * @returns {Promise<Object>}
 */
export function getHandoverSnapshotMobile(params = {}) {
  return getHandoverSnapshot({
    ...params,
    mobile: true
  })
}
