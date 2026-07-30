import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// 必须先初始化 i18n 并注册 JSX 翻译钩子，再挂载应用树。
import './i18n'
import App from './App'
import { t } from './i18n'
import { initializeApplicationLogging } from './services/logging'
import { installTauriIpcReloadGuard } from './services/tauriIpcReloadGuard'

import './styles.css'

// 必须早于日志和 React 挂载，避免启动恢复 IPC 在页面重载边界被 Tauri 错误重发。
installTauriIpcReloadGuard()

// 在 React 挂载前注册全局错误监听，确保启动阶段异常也进入固定日志文件。
initializeApplicationLogging()

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error(t('reactMountNodeRootWas_f58c'))
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
