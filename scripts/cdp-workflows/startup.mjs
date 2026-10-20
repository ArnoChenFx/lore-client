export async function runStartupWorkflow({ cdp, results, assert }) {
  results.initial = await cdp.evaluate(`({
    revisionRows: document.querySelectorAll(".revision-row").length,
    hasInspector: Boolean(document.querySelector(".inspector")),
    historyFooterRemoved: !document.querySelector(".history-footer"),
    historyGridRows:
      getComputedStyle(document.querySelector(".history-panel")).gridTemplateRows,
    bodyOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
  })`)
  assert(results.initial.revisionRows >= 10, 'Revision history was not fully rendered')
  assert(results.initial.hasInspector, 'The revision inspector was not rendered')
  assert(
    results.initial.historyFooterRemoved && results.initial.historyGridRows.trim().split(/\s+/).length === 3,
    `The removed revision footer still occupies a history grid row: ${JSON.stringify(results.initial)}`
  )
  assert(!results.initial.bodyOverflowX, 'The main page has horizontal overflow')

  /*
   * 历史按新到旧排列；精确 HEAD 上方的每一行都必须带相对状态类，
   * HEAD 自身及更旧历史不得误标。搜索隐藏 HEAD 后，状态仍由完整投影保留。
   */
  results.revisionsAheadOfHead = await cdp.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll(".revision-row"));
    const headIndex = rows.findIndex((row) => row.querySelector(".revision-row__meta em.is-head"));
    const aheadIndices = rows
      .map((row, index) => row.classList.contains("is-ahead-of-head") ? index : -1)
      .filter((index) => index >= 0);
    return {
      headIndex,
      aheadIndices,
      headMarked: headIndex >= 0 && rows[headIndex].classList.contains("is-ahead-of-head"),
      olderMarked: headIndex >= 0 && rows.slice(headIndex + 1).some((row) =>
        row.classList.contains("is-ahead-of-head")
      )
    };
  })()`)
  assert(
    results.revisionsAheadOfHead.headIndex >= 0 &&
      JSON.stringify(results.revisionsAheadOfHead.aheadIndices) ===
        JSON.stringify(Array.from({ length: results.revisionsAheadOfHead.headIndex }, (_, index) => index)) &&
      !results.revisionsAheadOfHead.headMarked &&
      !results.revisionsAheadOfHead.olderMarked,
    `Revision rows ahead of HEAD were classified incorrectly: ${JSON.stringify(results.revisionsAheadOfHead)}`
  )

  /*
   * 默认演示仓库的 HEAD 就是首行，因此真实界面覆盖“不误标”边界；
   * HEAD 落后时的正向分类与筛选稳定性由 HistoryPanel 组件夹具覆盖。
   */

  /*
   * 底部实例、分区和状态栏都是高密度缩写信息；每一项都必须提供完整 title，
   * 让鼠标用户无需猜测图标或短文本的语义。
   */
  results.bottomInformationTooltips = await cdp.evaluate(`(() => {
    const readItems = (selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => ({
        text: element.textContent?.trim() ?? "",
        title: element.getAttribute("title") ?? ""
      }));
    return {
      sidebar: readItems(".sidebar__instance > div"),
      status: readItems(".statusbar > span:not(.statusbar__spacer)")
    };
  })()`)
  assert(
    results.bottomInformationTooltips.sidebar.length === 2 &&
      results.bottomInformationTooltips.status.length === 6 &&
      [...results.bottomInformationTooltips.sidebar, ...results.bottomInformationTooltips.status].every(
        (item) => item.text.length > 0 && item.title.length > 0 && item.title !== item.text && item.title.includes('：')
      ),
    `Bottom information tooltips are incomplete: ${JSON.stringify(results.bottomInformationTooltips)}`
  )

  // 桌面交互表面不允许拖出跨面板文本选区；搜索输入仍必须保留文字编辑与选择。
  results.textSelectionPolicy = await cdp.evaluate(`(() => {
    const shell = document.querySelector(".app-shell");
    const input = document.querySelector(".sidebar__filter input");
    return {
      shell: shell ? getComputedStyle(shell).userSelect : "",
      input: input ? getComputedStyle(input).userSelect : ""
    };
  })()`)
  assert(
    results.textSelectionPolicy.shell === 'none' && results.textSelectionPolicy.input === 'text',
    `The interface text-selection policy is invalid: ${JSON.stringify(results.textSelectionPolicy)}`
  )
  /*
   * 顶部仓库工具栏必须真正释放垂直空间，而不是只把内部内容缩小后仍保留
   * 旧网格轨道。这里读取浏览器最终矩形，并同时确认动作已经采用横向排列。
   */
  results.compactToolbar = await cdp.evaluate(`(() => {
    const toolbar = document.querySelector(".toolbar");
    const repositorySwitcher = document.querySelector(
      ".repository-switcher"
    );
    const actions = Array.from(document.querySelectorAll(".toolbar-action"));
    const labeledAction = actions.find((action) =>
      action.querySelector(":scope > span")
    );
    return {
      height: toolbar?.getBoundingClientRect().height ?? 0,
      repositoryHeight:
        repositorySwitcher?.getBoundingClientRect().height ?? 0,
      maximumActionHeight: actions.length
        ? Math.max(
            ...actions.map(
              (action) => action.getBoundingClientRect().height,
            ),
          )
        : 0,
      actionCount: actions.length,
      actionLabels: actions.map(
        (action) =>
          action.getAttribute("aria-label") ??
          action.textContent?.trim() ??
          "",
      ),
      labeledActionDirection: labeledAction
        ? getComputedStyle(labeledAction).flexDirection
        : "",
      overflowX: toolbar
        ? toolbar.scrollWidth > toolbar.clientWidth
        : true
    };
  })()`)
  const expectedToolbarActions = [
    '同步',
    '推送',
    '新建修订',
    '打开项目目录',
    '命令',
    '全局搜索',
    '服务器设置',
    '客户端设置'
  ]
  assert(
    results.compactToolbar.height <= 42 &&
      results.compactToolbar.repositoryHeight <= 34 &&
      results.compactToolbar.maximumActionHeight <= 34 &&
      results.compactToolbar.actionCount === expectedToolbarActions.length &&
      expectedToolbarActions.every((label) => results.compactToolbar.actionLabels.includes(label)) &&
      results.compactToolbar.labeledActionDirection === 'row' &&
      !results.compactToolbar.overflowX,
    `The top toolbar did not release vertical space as expected: ${JSON.stringify(results.compactToolbar)}`
  )
  /*
   * 首次启动和缺少轨道偏好字段的配置都必须进入平铺模式。当前 Branch 的
   * 本地指针与精确 HEAD 仍需可见，其他 Branch 指针不能混入默认列表。
   */
  results.revisionLaneDefault = await cdp.evaluate(`(() => ({
    mode: document.querySelector(".history-list")?.dataset.laneMode ?? "",
    revisionRows: document.querySelectorAll(".revision-row").length,
    visibleBranchPointers: Array.from(
      document.querySelectorAll(".revision-row__meta > em")
    ).map((pointer) => pointer.textContent?.trim() ?? "")
  }))()`)
  assert(
    results.revisionLaneDefault.mode === 'flat' &&
      results.revisionLaneDefault.revisionRows === 10 &&
      results.revisionLaneDefault.visibleBranchPointers.includes('world/lighting-pass') &&
      results.revisionLaneDefault.visibleBranchPointers.includes('HEAD') &&
      results.revisionLaneDefault.visibleBranchPointers.every(
        (pointer) => pointer === 'world/lighting-pass' || pointer === 'HEAD'
      ),
    `Revision History did not default to the current-branch Flat view: ${JSON.stringify(results.revisionLaneDefault)}`
  )
}
