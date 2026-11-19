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
    // 子菜单展开时，第一次 Escape 只收起子菜单，第二次才关闭整个右键菜单（见 ChangeContextMenu 的键盘处理），
    // 所以逐次按键并确认菜单真的消失，而不是只发一次就假定它已经关闭。
    const closeContextMenu = async () => {
      const closed = `!document.querySelector('.change-context-menu')`
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await cdp.evaluate(closed)) return true
        await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await pause(60)
      }
      return cdp.evaluate(closed)
    }
    const submenuGeometry = `(() => {
      const submenu = document.querySelector('.change-context-menu .context-submenu');
      if (!submenu) return null;
      const rect = submenu.getBoundingClientRect();
      return {
        opensUp: submenu.classList.contains('opens-up'),
        // 向下展开时子菜单顶边贴着触发行顶边（允许 8px 的重叠与误差），向上展开则整体落在触发行上方。
        startsAtHost: rect.top >= (submenu.parentElement?.getBoundingClientRect().top ?? 0) - 8,
        top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height), viewportHeight: innerHeight,
        fullyVisible: rect.top >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
        // 与菜单自身一致，子菜单与视口边缘也要保留 8px 间距。
        withinGap: rect.top >= 8 && rect.bottom <= innerHeight - 8,
        items: submenu.querySelectorAll(':scope > button').length,
        clipped: Array.from(submenu.querySelectorAll(':scope > button')).some(button => button.scrollWidth > button.clientWidth + 1)
      };
    })()`
    /*
     * 右键的 `clientY` 默认固定在视口底边：菜单位置由触发点决定，这样它一定被夹到窗口底部，子菜单才会面临
     * 最坏的纵向空间，与文件行恰好落在哪一行无关；需要“上方空间充足”的场景时传入其他纵坐标表达式。
     * 已暂存的行没有“忽略”，逐行找第一个带该项的。返回展开后子菜单的真实几何；调用方负责关闭菜单。
     */
    const openIgnoreSubmenu = async (clientYExpression = 'innerHeight - 2') => {
      let hostFound = false
      const rowCount = await cdp.evaluate(`document.querySelectorAll('.change-file-row').length`)
      for (let index = 0; index < rowCount && !hostFound; index += 1) {
        await cdp.evaluate(`(() => {
          const row = document.querySelectorAll('.change-file-row')[${index}];
          const bounds = row?.getBoundingClientRect();
          row?.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true,
            clientX: Math.round((bounds?.left ?? 300) + 40), clientY: ${clientYExpression}
          }));
        })()`)
        hostFound = await waitForEvaluatedState(cdp, ignoreHost, Boolean, 8)
        if (!hostFound) {
          await closeContextMenu()
          await pause(80)
        }
      }
      assert(hostFound, 'No Local Changes row offered the Ignore submenu')
      // 菜单有入场动画，悬停坐标会过期；宿主按钮点击同样展开子菜单，且没有时序依赖。
      await cdp.evaluate(`Array.from(document.querySelectorAll('.change-context-menu .context-submenu-host > button'))
        .find(candidate => candidate.textContent.trim().startsWith('忽略'))?.click()`)
      return waitForEvaluatedState(cdp, submenuGeometry, Boolean)
    }

    const ignoreSubmenu = await openIgnoreSubmenu()
    assert(ignoreSubmenu?.items === 4 && ignoreSubmenu.fullyVisible && ignoreSubmenu.withinGap && !ignoreSubmenu.clipped,
      `The Ignore submenu is clipped or incomplete near the bottom edge: ${JSON.stringify(ignoreSubmenu)}`)
    assert(await closeContextMenu(), 'The context menu did not close on Escape')

    /*
     * 上面用的是真实标签，而中文单行标签下子菜单向下展开的底边只比 8px 间距阈值高出一两像素，
     * 把“向上展开”整个去掉也可能侥幸通过，所以它只是稳妥而非灵敏。这里临时把每个子菜单项撑到 44px，
     * 让向下展开必然越出视口（与语言、字体都无关）；此时子菜单必须翻转到触发行上方并保持完整可见。
     */
    await cdp.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'smoke-tall-submenu';
      style.textContent = '.change-context-menu .context-submenu > button { min-height: 44px; }';
      document.head.append(style);
    })()`)
    let tallSubmenu = null
    try {
      tallSubmenu = await openIgnoreSubmenu()
      // 高度断言保证压力样式确实生效；否则样式失效会让这条守护悄悄退化成上面那条。
      assert(tallSubmenu?.height >= 170, `The tall-submenu fixture did not apply: ${JSON.stringify(tallSubmenu)}`)
      assert(
        tallSubmenu.opensUp && tallSubmenu.items === 4 && tallSubmenu.fullyVisible && tallSubmenu.withinGap && !tallSubmenu.clipped,
        `A tall Ignore submenu must open upward and stay inside the viewport: ${JSON.stringify(tallSubmenu)}`
      )
    } finally {
      await cdp.evaluate(`document.getElementById('smoke-tall-submenu')?.remove()`)
      await closeContextMenu()
    }

    /*
     * 与上面对称：菜单打开在视口上部、下方空间充足时，子菜单必须保持默认的向下展开，不能无谓地翻转到触发行上方。
     * 它抓的是“总是向上展开”这类回归，和上面抓“从不向上展开”的检查互为补充。
     */
    const roomySubmenu = await openIgnoreSubmenu('120')
    assert(
      roomySubmenu?.items === 4 && !roomySubmenu.opensUp && roomySubmenu.startsAtHost && roomySubmenu.fullyVisible && roomySubmenu.withinGap,
      `An Ignore submenu with room below must keep opening downward: ${JSON.stringify(roomySubmenu)}`
    )
    assert(await closeContextMenu(), 'The context menu did not close on Escape')
    results.localChangesLayout = { independent, collapsed, restored, large, small, smallRestored, expanded, ignoreSubmenu, tallSubmenu, roomySubmenu }
  } finally {
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...originalViewport, deviceScaleFactor: 1, mobile: false })
  }
}
