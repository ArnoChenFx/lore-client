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
    /*
     * 右键菜单贴近窗口底边时，“忽略”子菜单不能被窗口截断。Instance 级条目让子菜单变高，
     * 较高的子菜单必须改为向上展开；1280×720 是最低验收尺寸，菜单在这里几乎总是贴底。
     */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
    await navigate('本地更改', '.change-file-row')
    const pause = (milliseconds) => cdp.evaluate(`new Promise(resolve => setTimeout(resolve, ${milliseconds}))`)
    const ignoreHost = `Boolean(Array.from(document.querySelectorAll('.change-context-menu .context-submenu-host > button'))
      .find(candidate => candidate.textContent.trim().startsWith('忽略')))`
    let hostFound = false
    const rowCount = await cdp.evaluate(`document.querySelectorAll('.change-file-row').length`)
    /*
     * 右键的 `clientY` 固定在视口底边：菜单位置由触发点决定，这样它一定被夹到窗口底部，子菜单才会面临
     * 最坏的纵向空间，与文件行恰好落在哪一行无关。已暂存的行没有“忽略”，逐行找第一个带该项的。
     */
    for (let index = 0; index < rowCount && !hostFound; index += 1) {
      await cdp.evaluate(`(() => {
        const row = document.querySelectorAll('.change-file-row')[${index}];
        const bounds = row?.getBoundingClientRect();
        row?.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true,
          clientX: Math.round((bounds?.left ?? 300) + 40), clientY: innerHeight - 2
        }));
      })()`)
      hostFound = await waitForEvaluatedState(cdp, ignoreHost, Boolean, 8)
      if (!hostFound) {
        await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await pause(80)
      }
    }
    assert(hostFound, 'No Local Changes row offered the Ignore submenu')
    // 菜单有入场动画，悬停坐标会过期；宿主按钮点击同样展开子菜单，且没有时序依赖。
    await cdp.evaluate(`Array.from(document.querySelectorAll('.change-context-menu .context-submenu-host > button'))
      .find(candidate => candidate.textContent.trim().startsWith('忽略'))?.click()`)
    const ignoreSubmenu = await waitForEvaluatedState(cdp, `(() => {
      const submenu = document.querySelector('.change-context-menu .context-submenu');
      if (!submenu) return null;
      const rect = submenu.getBoundingClientRect();
      return {
        opensUp: submenu.classList.contains('opens-up'),
        top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewportHeight: innerHeight,
        fullyVisible: rect.top >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
        // 与菜单自身一致，子菜单与视口边缘也要保留 8px 间距。中文标签下向下展开的底边恰在这个阈值附近
        // （亚像素差异就会翻转），所以这里只是稳妥而非灵敏的集成守护；判定本身由 `shouldOpenSubmenuUp` 的单元测试覆盖。
        withinGap: rect.top >= 8 && rect.bottom <= innerHeight - 8,
        items: submenu.querySelectorAll(':scope > button').length,
        clipped: Array.from(submenu.querySelectorAll(':scope > button')).some(button => button.scrollWidth > button.clientWidth + 1)
      };
    })()`, Boolean)
    assert(ignoreSubmenu?.items === 4 && ignoreSubmenu.fullyVisible && ignoreSubmenu.withinGap && !ignoreSubmenu.clipped,
      `The Ignore submenu is clipped or incomplete near the bottom edge: ${JSON.stringify(ignoreSubmenu)}`)
    await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    results.localChangesLayout = { independent, collapsed, restored, large, small, smallRestored, expanded, ignoreSubmenu }
  } finally {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...originalViewport, deviceScaleFactor: 1, mobile: false })
  }
}
