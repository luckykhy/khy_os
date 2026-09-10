import { configureStore } from '@reduxjs/toolkit'
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux'
import workspaceReducer from './workspaceSlice'
import permissionReducer from './permissionSlice'
import toolExecutionReducer from './toolExecutionSlice'
import messageReducer from './messageSlice'
import toastReducer from './toastSlice'

export const store = configureStore({
  reducer: {
    workspace: workspaceReducer,
    permission: permissionReducer,
    toolExecution: toolExecutionReducer,
    message: messageReducer,
    toast: toastReducer,
  },
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

export const useAppDispatch = () => useDispatch<AppDispatch>()
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
