// openWorkspace — 切换工作空间的唯一渲染层入口（[DESIGN-ARCH-125] P-02）。
//
// 此前「打开工作区」这条链路在渲染层被写了三遍：TitleBar（窗口菜单项）、
// WorkspaceSidebar（账户菜单 / 添加项目），外加 CommandCenter 里一份空壳
// （action 只有 console.log）。三份并存 = 改一处漏两处。这里收敛成一份：
//
//   校验与持久化在 main（workspace:open → switchWorkspace，见 main/index.ts），
//   渲染层只负责「发起 → 广播 → 告知结果」。
//
// 广播沿用既有的窗口事件 khy:workspace-changed，不新增事件总线：文件树、
// 文件索引、标题栏 chip、卡片选择器都已经在监听它。

import { store } from '../state/store'
import { addToast } from '../state/toastSlice'

export interface WorkspaceOpenResult {
  ok: boolean
  path?: string
  error?: string
  /** 用户在系统目录框里点了取消 —— 不是失败，调用方不应报错。 */
  canceled?: boolean
}

interface WorkspaceApi {
  workspaceOpen?: (target?: string) => Promise<WorkspaceOpenResult>
}

/**
 * 切换工作空间。
 * @param target 目标目录绝对路径；省略则弹系统目录框（「打开其他文件夹…」）。
 * 成功时已广播 khy:workspace-changed；失败/取消时已给出用户可读提示。
 */
export async function openWorkspace(target?: string): Promise<WorkspaceOpenResult> {
  const api = (window as unknown as { __KHYOS__?: WorkspaceApi }).__KHYOS__
  if (!api?.workspaceOpen) {
    const error = '工作空间切换不可用：preload 未注入 __KHYOS__，请重启应用'
    store.dispatch(addToast({ type: 'error', title: error }))
    return { ok: false, error }
  }
  try {
    const res = await api.workspaceOpen(target)
    if (res?.canceled) return { ok: false, canceled: true }
    if (!res?.ok) {
      const error = res?.error || '工作空间切换失败：host 进程无响应，请重试'
      store.dispatch(addToast({ type: 'error', title: error }))
      return { ok: false, error }
    }
    // 各消费者（文件树 / 文件索引 / 标题栏 chip / 卡片选择器）按既有约定重新发现根
    window.dispatchEvent(new Event('khy:workspace-changed'))
    store.dispatch(addToast({ type: 'info', title: `工作空间已切换：${res.path || ''}` }))
    return res
  } catch (err) {
    const error = `工作空间切换失败：${String(err)}，请重试`
    store.dispatch(addToast({ type: 'error', title: error }))
    return { ok: false, error }
  }
}
