import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// 必须先初始化 i18n 并注册 JSX 翻译钩子，再挂载应用树。
import './i18n'
import App from './App'
import { t } from './i18n'

import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error(t('reactMountNodeRootWas_f58c'))
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
