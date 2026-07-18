/**
 * Browser-side WASM bridge.
 *
 * JS UI layer keeps rendering, events, and network.
 * WASM module handles pure compute exports.
 */

const bridgeCache = new Map()

class WasmBridge {
  constructor(url, module, instance) {
    this.url = url
    this.module = module
    this.instance = instance
    this.exportsMeta = WebAssembly.Module.exports(module)
  }

  listExports(kind = null) {
    if (!kind) return this.exportsMeta
    return this.exportsMeta.filter(item => item.kind === kind)
  }

  listFunctions() {
    return this.listExports('function').map(item => item.name)
  }

  hasFunction(name) {
    return typeof this.instance?.exports?.[name] === 'function'
  }

  callFunction(name, args = []) {
    const fn = this.instance?.exports?.[name]
    if (typeof fn !== 'function') {
      const available = this.listFunctions()
      throw new Error(
        `WASM function "${name}" not found. Available: ${available.length ? available.join(', ') : '(none)'}`
      )
    }
    return fn(...args)
  }
}

function resolveUrl(url) {
  if (!url) throw new Error('WASM URL is required')
  return String(url)
}

function normalizeImports(imports) {
  if (imports && typeof imports === 'object') return imports
  return { env: {} }
}

export async function loadWasmBridge(url, imports = { env: {} }) {
  const normalizedUrl = resolveUrl(url)
  const key = normalizedUrl
  const cached = bridgeCache.get(key)
  if (cached) return cached

  const response = await fetch(normalizedUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch WASM module: ${normalizedUrl} (${response.status})`)
  }

  const bytes = await response.arrayBuffer()
  const importObject = normalizeImports(imports)
  const { module, instance } = await WebAssembly.instantiate(bytes, importObject)
  const bridge = new WasmBridge(normalizedUrl, module, instance)
  bridgeCache.set(key, bridge)
  return bridge
}

export function clearWasmBridgeCache() {
  bridgeCache.clear()
}

export { WasmBridge }

