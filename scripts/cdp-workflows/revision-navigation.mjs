export async function runRevisionNavigationWorkflow({ cdp, results, assert, delay }) {
  // Revision 单击只选择并更新检查器，不应触发 Checkout 或显示操作通知。
  await cdp.evaluate(`document.querySelectorAll(".revision-row")[2]?.click()`)
  await delay(60)
  results.revisionSingleClick = await cdp.evaluate(`({
    selected: document.querySelectorAll(".revision-row")[2]
      ?.classList.contains("is-selected") ?? false,
    revision: document.querySelectorAll(".revision-row")[2]
      ?.querySelector(".revision-row__meta code")?.textContent?.trim() ?? "",
    hasOperationToast: Boolean(document.querySelector(".toast"))
  })`)
  assert(
    results.revisionSingleClick.selected &&
      results.revisionSingleClick.revision.length > 0 &&
      !results.revisionSingleClick.hasOperationToast,
    `A single revision click must not perform checkout: ${JSON.stringify(results.revisionSingleClick)}`
  )

  // 双击同一 Revision 才触发 Checkout；浏览器演示必须明确说明桌面行为。
  await cdp.evaluate(`document.querySelectorAll(".revision-row")[2]
    ?.dispatchEvent(new MouseEvent("dblclick", {
      bubbles: true,
      cancelable: true
    }))`)
  await delay(60)
  results.revisionDoubleClick = await cdp.evaluate(`({
    title: document.querySelector(".toast strong")?.textContent?.trim() ?? "",
    detail: document.querySelector(".toast small")?.textContent?.trim() ?? ""
  })`)
  assert(
    results.revisionDoubleClick.title === '浏览器演示模式' &&
      results.revisionDoubleClick.detail.includes('检出') &&
      results.revisionDoubleClick.detail.includes(results.revisionSingleClick.revision),
    `Double-clicking a revision did not trigger the checkout entry point: ${JSON.stringify(results.revisionDoubleClick)}`
  )
  await cdp.evaluate(`document.querySelector(".toast > button")?.click()`)
  await delay(40)
}
