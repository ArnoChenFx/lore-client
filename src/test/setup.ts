import i18n, { i18nReady } from '../i18n'

/**
 * Vitest 全局准备：等待 i18n 初始化完成
 * 组件测试若只依赖 useTranslation 而不导入 `../i18n`，也必须经此 setup 挂上同一实例。
 */
await i18nReady
await i18n.changeLanguage('en-US')
