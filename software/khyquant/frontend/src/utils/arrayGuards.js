/**
 * 数组类型守卫工具函数
 * 用于确保响应式变量始终保持数组类型，防止 "slice is not a function" 错误
 */

/**
 * 确保值是数组类型
 * @param {any} value - 需要验证的值
 * @param {Array} fallback - 如果值不是数组时返回的默认值
 * @param {string} variableName - 变量名称（用于日志）
 * @returns {Array} 验证后的数组
 */
export function ensureArray(value, fallback = [], variableName = 'unknown') {
  if (!Array.isArray(value)) {
    console.error(`❌ [ArrayGuard] ${variableName} is not an array:`, {
      type: typeof value,
      value: value,
      stack: new Error().stack
    })
    return fallback
  }
  return value
}

/**
 * 创建响应式数组的安全包装器
 * @param {Ref} refValue - Vue ref对象
 * @param {string} variableName - 变量名称
 * @returns {Object} 包含get和set方法的对象
 */
export function createSafeArrayRef(refValue, variableName) {
  return {
    get value() {
      return ensureArray(refValue.value, [], variableName)
    },
    set value(newValue) {
      if (!Array.isArray(newValue)) {
        console.error(`❌ [ArrayGuard] Attempting to set ${variableName} to non-array:`, {
          type: typeof newValue,
          value: newValue
        })
        refValue.value = []
      } else {
        refValue.value = newValue
      }
    }
  }
}

/**
 * 验证API响应中的数组字段
 * @param {Object} response - API响应对象
 * @param {string} fieldPath - 字段路径（支持嵌套，如 'data.items'）
 * @param {Array} fallback - 默认值
 * @returns {Array} 验证后的数组
 */
export function validateApiArrayField(response, fieldPath, fallback = []) {
  try {
    const fields = fieldPath.split('.')
    let value = response
    
    for (const field of fields) {
      if (value && typeof value === 'object' && field in value) {
        value = value[field]
      } else {
        console.warn(`⚠️ [API Validation] Field path "${fieldPath}" not found in response`)
        return fallback
      }
    }
    
    if (!Array.isArray(value)) {
      console.error(`❌ [API Validation] Field "${fieldPath}" is not an array:`, {
        type: typeof value,
        value: value
      })
      return fallback
    }
    
    return value
  } catch (error) {
    console.error(`❌ [API Validation] Error validating field "${fieldPath}":`, error)
    return fallback
  }
}

/**
 * 为响应式数组添加watch守卫
 * @param {Ref} refValue - Vue ref对象
 * @param {string} variableName - 变量名称
 * @param {Function} watch - Vue watch函数
 */
export function addArrayWatchGuard(refValue, variableName, watch) {
  watch(refValue, (newValue) => {
    if (!Array.isArray(newValue)) {
      console.error(`❌❌❌ [Watch Guard] ${variableName} was set to non-array:`, {
        type: typeof newValue,
        value: newValue,
        stack: new Error().stack
      })
      // 强制重置为空数组
      refValue.value = []
    }
  }, { immediate: true })
}
