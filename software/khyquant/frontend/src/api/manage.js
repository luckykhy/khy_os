import request from '@/utils/request'

// Unified management plane API. Every call goes through the backend's single
// managementRegistry funnel — the same one the `khy manage` CLI uses — so the
// visual surface and the command surface can never diverge.
export const manageAPI = {
  // List all manageable resources + their capability matrix.
  listResources() {
    return request({
      url: '/manage',
      method: 'get'
    })
  },

  // Describe one resource (capabilities + arg schema).
  describeResource(resourceId) {
    return request({
      url: `/manage/${resourceId}`,
      method: 'get'
    })
  },

  // Invoke an op on a resource. args is the op payload (e.g. { id } / { username, email, password }).
  invoke(resourceId, op, args = {}) {
    return request({
      url: `/manage/${resourceId}/${op}`,
      method: 'post',
      data: args
    })
  }
}
