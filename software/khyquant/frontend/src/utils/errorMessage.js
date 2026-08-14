export function getFriendlyErrorMessage(error, fallback = '操作失败，请稍后重试') {
  const responseData = error?.response?.data
  if (typeof responseData?.message === 'string' && responseData.message.trim()) {
    const message = responseData.message.trim()
    const detailField = responseData?.details?.field
    const detailHint = responseData?.details?.hint
    if (detailField && detailHint) {
      return `${message} [${detailField}] ${detailHint}`
    }
    if (detailField) {
      return `${message} [${detailField}]`
    }
    if (typeof responseData?.error === 'string' && responseData.error && responseData.error !== message) {
      return `${message}: ${responseData.error}`
    }
    return message
  }
  if (typeof error?.message === 'string' && error.message.trim()) {
    if (error.message.includes('Network Error')) {
      return '网络连接异常，请检查网络后重试'
    }
    if (error.message.includes('timeout')) {
      return '请求超时，请稍后重试'
    }
    return error.message
  }
  return fallback
}
