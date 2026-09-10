// ToastContainer — redux-wired toast host (resolves the pre-existing broken
// import in App.tsx; renders the presentational ToastContainer from Toast.tsx).

import { useAppSelector, useAppDispatch } from '../../state/store'
import { removeToast } from '../../state/toastSlice'
import { ToastContainer as Presentational } from './Toast'

export function ToastContainer() {
  const toasts = useAppSelector((state) => state.toast.toasts)
  const dispatch = useAppDispatch()
  // redux toast uses { title, description? } — adapt to the presentational { message }
  const viewToasts = toasts.map((t) => ({
    id: t.id,
    message: t.description ? `${t.title} ${t.description}` : t.title,
    type: t.type,
    duration: t.duration
  }))
  return <Presentational toasts={viewToasts} onRemove={(id) => dispatch(removeToast(id))} />
}
