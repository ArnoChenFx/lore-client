import type zhCN from './locales/zh-CN'

/**
 * 让 `t('localChanges')` 等调用获得键路径自动补全与校验。
 * 资源形状以简体中文文件为唯一类型源。
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: {
      translation: typeof zhCN
    }
  }
}

export {}
