export async function runLazyViewRecoveryWorkflow({ cdp, results, assert, delay, waitForEvaluatedState, openFreshApplicationDocument, captureScreenshot, applicationUrl }) {
  /*
   * 设置弹层的懒加载 chunk 在本文档内尚未加载，Fetch 拦截只作用于它。失败必须显示可关闭的错误
   * 而不是空白区域。浏览器会缓存失败的模块请求，同一文档内的重试可能仍然失败，因此只断言
   * 结果不是空白，并记录重试是否恢复；重新加载页面后必须能正常打开。
   */
  await openFreshApplicationDocument(cdp, () => cdp.send('Page.navigate', { url: applicationUrl }))
  let failSettingsChunk = true
  let blockedSettingsRequests = 0
  cdp.on('Fetch.requestPaused', (params) => {
    const command = failSettingsChunk ? 'Fetch.failRequest' : 'Fetch.continueRequest'
    if (failSettingsChunk) blockedSettingsRequests += 1
    cdp
      .send(command, failSettingsChunk ? { requestId: params.requestId, errorReason: 'Failed' } : { requestId: params.requestId })
      .catch(() => {})
  })
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*SettingsDialog*', requestStage: 'Request' }] })
  await cdp.evaluate(`document.querySelector('button[aria-label="客户端设置"]')?.click()`)
  const lazyFailure = await waitForEvaluatedState(
    cdp,
    `(() => {
      const alert = document.querySelector('[role="alertdialog"]')
      return {
        visible: Boolean(alert),
        title: alert?.querySelector('h2')?.textContent?.trim() ?? '',
        hasRetry: Array.from(alert?.querySelectorAll('button') ?? []).some((button) => button.textContent?.trim() === '重试'),
        settingsDialogVisible: Boolean(document.querySelector('.settings-dialog'))
      }
    })()`,
    (state) => state.visible
  )
  assert(
    lazyFailure.visible &&
      lazyFailure.title === '此视图暂时无法显示。' &&
      lazyFailure.hasRetry &&
      !lazyFailure.settingsDialogVisible,
    `A failed lazy dialog did not show the localized retryable error: ${JSON.stringify(lazyFailure)}`
  )
  await captureScreenshot(cdp, 'cdp-lazy-view-failure.png')

  failSettingsChunk = false
  await cdp.send('Fetch.disable')
  await cdp.evaluate(`Array.from(document.querySelectorAll('[role="alertdialog"] button'))
    .find((button) => button.textContent?.trim() === '重试')?.click()`)
  await delay(300)
  const afterRetry = await waitForEvaluatedState(
    cdp,
    `({
      errorVisible: Boolean(document.querySelector('[role="alertdialog"]')),
      settingsDialogVisible: Boolean(document.querySelector('.settings-dialog'))
    })`,
    (state) => state.errorVisible !== state.settingsDialogVisible
  )
  assert(
    afterRetry.errorVisible !== afterRetry.settingsDialogVisible,
    `The lazy dialog region was blank after retry: ${JSON.stringify(afterRetry)}`
  )

  await openFreshApplicationDocument(cdp, () => cdp.send('Page.reload'))
  await cdp.evaluate(`document.querySelector('button[aria-label="客户端设置"]')?.click()`)
  const recoveredAfterReload = await waitForEvaluatedState(
    cdp,
    `Boolean(document.querySelector('.settings-dialog'))`,
    (visible) => visible
  )
  assert(recoveredAfterReload === true, 'Reloading the page did not restore the settings dialog after a failed chunk load')
  results.lazyViewFailure = {
    blockedSettingsRequests,
    failure: lazyFailure,
    retryOutcome: afterRetry.settingsDialogVisible ? 'recovered' : 'error-still-shown',
    recoveredAfterReload
  }
}
