/** Real pointer/layout and remount checks for independent Local Changes sections. */
export async function runLocalChangesLayoutWorkflow({ cdp, results, assert, waitForEvaluatedState }) {
  const originalViewport = await cdp.evaluate('({ width: innerWidth, height: innerHeight })')
  const navigate = async (label, selector) => {
    await cdp.evaluate(`Array.from(document.querySelectorAll('.sidebar__primary button'))
      .find(button => button.textContent.includes(${JSON.stringify(label)}))?.click()`)
    const ready = await waitForEvaluatedState(cdp, `Boolean(document.querySelector(${JSON.stringify(selector)}))`, Boolean)
    assert(ready, `Navigation to ${label} did not mount ${selector}`)
  }
  const section = (index) => `document.querySelectorAll('.change-list-section')[${index}]`
  const click = async (index, label) => {
    await cdp.evaluate(`${section(index)}.querySelector('button[aria-label="${label}"]')?.click()`)
  }
  const sectionState = `Array.from(document.querySelectorAll('.change-list-section')).map(section => ({
    flat: section.querySelector('button[aria-label="平铺视图"]')?.getAttribute('aria-pressed') === 'true',
    expanded: Array.from(section.querySelectorAll('.change-directory-row')).map(row => row.getAttribute('aria-expanded')),
    files: section.querySelectorAll('.change-file-row').length
  }))`
  const layoutState = `(() => {
    const panel = document.querySelector('.local-changes').getBoundingClientRect();
    const composer = document.querySelector('.revision-composer').getBoundingClientRect();
    const editor = document.querySelector('.revision-composer textarea').getBoundingClientRect();
    const sections = Array.from(document.querySelectorAll('.change-list-section')).map(section => section.getBoundingClientRect().height);
    return { editor: editor.height, sections, fits: composer.bottom <= panel.bottom + 1 };
  })()`
  const fits = (state) => state?.fits && state.sections.length === 2 && state.sections.every(height => height >= 95)
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    await navigate('本地更改', '.revision-composer__resizer')
    await click(0, '平铺视图')
    const independent = await waitForEvaluatedState(cdp, sectionState, state => state?.[0]?.flat)
    assert(independent[0].flat && !independent[1].flat && independent[1].expanded.length > 0,
      `Changing the unstaged view affected the staged view: ${JSON.stringify(independent)}`)
    await click(0, '目录树视图')
    await click(1, '收起全部本地更改文件夹')
    const collapsed = await waitForEvaluatedState(cdp, sectionState,
      state => state?.[1]?.expanded.length > 0 && state[1].expanded.every(value => value === 'false'))
    assert(collapsed[0].expanded.some(value => value === 'true') && collapsed[1].expanded.every(value => value === 'false'),
      `Collapsing staged folders affected unstaged folders: ${JSON.stringify(collapsed)}`)
    await navigate('分支总览', '.branch-card')
    await navigate('本地更改', '.revision-composer__resizer')
    const restored = await waitForEvaluatedState(cdp, sectionState,
      state => state?.[1]?.expanded.length > 0 && state[1].expanded.every(value => value === 'false'))
    assert(restored[0].expanded.some(value => value === 'true') && restored[1].expanded.every(value => value === 'false'),
      `Section collapse state did not survive remount: ${JSON.stringify(restored)}`)
    await click(1, '展开全部本地更改文件夹')

    // Let remount and ResizeObserver updates settle before hit-testing the pointer handle.
    await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const handle = await cdp.evaluate(`(() => {
      const r = document.querySelector('.revision-composer__resizer').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...handle, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y - 500, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x, y: handle.y - 500, button: 'left', clickCount: 1 })
    const large = await waitForEvaluatedState(cdp, layoutState, state => fits(state) && state.editor > 400)
    assert(fits(large) && large.editor > 400, `Editor resize did not expand: ${JSON.stringify(large)}`)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 700, deviceScaleFactor: 1, mobile: false })
    const small = await waitForEvaluatedState(cdp, layoutState, fits)
    assert(fits(small) && small.editor < large.editor, `Shrinking the window clipped Local Changes: ${JSON.stringify(small)}`)
    await navigate('分支总览', '.branch-card')
    await navigate('本地更改', '.revision-composer__resizer')
    const smallRestored = await waitForEvaluatedState(cdp, layoutState, fits)
    assert(fits(smallRestored) && smallRestored.editor < large.editor,
      `Restoring a saved tall editor clipped Local Changes: ${JSON.stringify(smallRestored)}`)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    const expanded = await waitForEvaluatedState(cdp, layoutState, state => fits(state) && Math.abs(state.editor - large.editor) <= 1)
    assert(fits(expanded) && Math.abs(expanded.editor - large.editor) <= 1,
      `Window clamping overwrote the preferred editor height: ${JSON.stringify(expanded)}`)
    results.localChangesLayout = { independent, collapsed, restored, large, small, smallRestored, expanded }
  } finally {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...originalViewport, deviceScaleFactor: 1, mobile: false })
  }
}
