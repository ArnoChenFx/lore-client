export async function runSettingsWorkflow({ cdp, results, assert, delay, waitForEvaluatedState }) {
  // 纯前端演示同样提供产品级 Ctrl+P，但不拦截查找、刷新等其他浏览器默认快捷键。
  results.frontendBrowserShortcuts = await cdp.evaluate(`(() => {
    const findEvent = new KeyboardEvent("keydown", {
      key: "f",
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    const shiftedPaletteEvent = new KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    window.dispatchEvent(findEvent);
    window.dispatchEvent(shiftedPaletteEvent);
    return {
      findPrevented: findEvent.defaultPrevented,
      shiftedPalettePrevented: shiftedPaletteEvent.defaultPrevented
    };
  })()`)
  assert(
    !results.frontendBrowserShortcuts.findPrevented &&
      !results.frontendBrowserShortcuts.shiftedPalettePrevented,
    `The browser demo unexpectedly blocked native shortcuts: ${JSON.stringify(results.frontendBrowserShortcuts)}`
  )

  await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      bubbles: true
    }))
  `)
  await delay(60)
  results.commandPalette = await cdp.evaluate(`Boolean(document.querySelector(".command-palette"))`)
  assert(results.commandPalette, 'Ctrl+P did not open the command palette')

  await cdp.evaluate(`
    document.querySelector(".command-palette input")?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true
    }));
    document.querySelector('button[aria-label="服务器设置"]')?.click()
  `)
  await delay(60)
  results.serverDialog = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".server-dialog")),
    serverUrl: document.querySelector("#lore-server-url")?.value ?? "",
    hasReadableError: Boolean(document.querySelector(".server-dialog__empty.is-error"))
  })`)
  assert(results.serverDialog.visible, 'The server repository panel did not open')
  assert(
    results.serverDialog.hasReadableError,
    'Browser demo mode did not display an explicit server-connection limitation'
  )
  /*
   * 服务器仓库地址是临时浏览草稿。先改成与仓库配置不同的值，后续打开
   * Shared Store 时验证该草稿不会再通过 App 共享状态泄漏过去。
   */
  await cdp.evaluate(`(() => {
    const input = document.querySelector("#lore-server-url");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, "lore://temporary-browser:41337");
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  })()`)
  await cdp.evaluate(`document.querySelector(".server-dialog__header .icon-button")?.click()`)
  await delay(40)

  await cdp.evaluate(`document.querySelector('button[aria-label="全局搜索"]')?.click()`)
  await delay(50)
  results.search = await cdp.evaluate(`(() => {
    const input = document.querySelector(".search-dialog input");
    if (!input) return { visible: false, results: 0 };
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, "lighting");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return { visible: true };
  })()`)
  await delay(50)
  results.search.results = await cdp.evaluate(`document.querySelectorAll(".search-results > button").length`)
  assert(results.search.visible && results.search.results > 0, 'Repository search returned no matching results')
  await cdp.evaluate(`document.querySelector(".search-dialog__input > button")?.click()`)
  await delay(40)

  await cdp.evaluate(`document.querySelector('button[aria-label="客户端设置"]')?.click()`)
  await waitForEvaluatedState(
    cdp,
    'Boolean(document.querySelector(".settings-dialog"))',
    (visible) => visible
  )
  results.settings = await cdp.evaluate(`({
    visible: Boolean(document.querySelector(".settings-dialog")),
    categories: document.querySelectorAll(
      ".settings-categories > button[role=\\"tab\\"]"
    ).length,
    activePanel: document.querySelector(
      '.settings-page[role="tabpanel"]:not([hidden])'
    )?.id ?? null,
    themeOptions: document.querySelectorAll(
      ".theme-options:not(.language-options) button"
    ).length
  })`)
  assert(
    results.settings.visible &&
      results.settings.categories === 5 &&
      results.settings.activePanel === 'settings-panel-general' &&
      results.settings.themeOptions === 3,
    `The settings panel category workspace is invalid: ${JSON.stringify(results.settings)}`
  )
  await cdp.evaluate(`(() => {
    const activeTab = document.querySelector(
      '.settings-categories > button[aria-selected="true"]'
    );
    activeTab?.focus();
    activeTab?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true
    }));
  })()`)
  await delay(40)
  Object.assign(
    results.settings,
    await cdp.evaluate(`({
    identityPanelVisible: !document.querySelector(
      "#settings-panel-identity"
    )?.hidden,
    defaultIdentityAuthor: Boolean(
      document.querySelector('input[aria-label="默认提交作者名"]')
    ),
    defaultIdentityEmail: Boolean(
      document.querySelector('input[aria-label="默认提交邮箱"]')
    ),
    defaultIdentityAvatar: Boolean(
      document.querySelector(
        "#settings-panel-identity .revision-author-avatar"
      )
    )
  })`)
  )
  assert(
    results.settings.identityPanelVisible &&
      results.settings.defaultIdentityAuthor &&
      results.settings.defaultIdentityEmail &&
      results.settings.defaultIdentityAvatar,
    `The settings panel cannot switch to default commit identity: ${JSON.stringify(results.settings)}`
  )
  await cdp.evaluate(`Array.from(document.querySelectorAll(".settings-categories > button"))
    .find((button) => button.textContent.includes("集成"))
    ?.click()`)
  await delay(40)
  Object.assign(
    results.settings,
    await cdp.evaluate(`(() => {
      const panel = document.querySelector("#settings-panel-integrations");
      return {
        integrationsPanelVisible: panel instanceof HTMLElement && !panel.hidden,
        externalToolGroups: panel?.querySelectorAll(".settings-external-tools").length ?? 0,
        configuredToolRows: panel?.querySelectorAll(".settings-external-tools__list > button").length ?? 0
      };
    })()`)
  )
  await delay(40)
  Object.assign(
    results.settings,
    await cdp.evaluate(`({
      externalDiffNameInput: Boolean(
        document.querySelector("#settings-panel-integrations .settings-external-diff__field input")
      ),
      externalDiffExecutableInput: document.querySelectorAll(
        "#settings-panel-integrations .settings-external-diff__field input"
      ).length >= 2,
      externalDiffArgumentTemplate:
        document.querySelectorAll("#settings-panel-integrations textarea").length >= 2
    })`)
  )
  assert(
    results.settings.integrationsPanelVisible &&
      results.settings.externalToolGroups === 2 &&
      results.settings.configuredToolRows >= 8 &&
      results.settings.externalDiffNameInput &&
      results.settings.externalDiffExecutableInput &&
      results.settings.externalDiffArgumentTemplate,
    `The external Diff integration editor is incomplete: ${JSON.stringify(results.settings)}`
  )
  await cdp.evaluate(`Array.from(document.querySelectorAll(".settings-categories > button"))
    .find((button) => button.textContent.includes("存储"))
    ?.click()`)
  await delay(40)
  results.sharedStoreEndpointRoles = await cdp.evaluate(`(() => {
    const panel = document.querySelector("#settings-panel-storage");
    const input = panel?.querySelector(".settings-shared-store__create input");
    const label = input?.closest("label");
    return {
      visible: panel instanceof HTMLElement && !panel.hidden,
      value: input instanceof HTMLInputElement ? input.value : "",
      label: label?.querySelector(":scope > span")?.textContent?.trim() ?? "",
      hint: label?.querySelector(":scope > small")?.textContent?.trim() ?? ""
    };
  })()`)
  assert(
    results.sharedStoreEndpointRoles.visible &&
      results.sharedStoreEndpointRoles.value === results.serverDialog.serverUrl &&
      results.sharedStoreEndpointRoles.value !== 'lore://temporary-browser:41337' &&
      results.sharedStoreEndpointRoles.label === 'Shared Store 目标服务器' &&
      results.sharedStoreEndpointRoles.hint.includes('仅用于本次创建'),
    `Shared Store unexpectedly reused the temporary server-browser draft: ${JSON.stringify(results.sharedStoreEndpointRoles)}`
  )
  await cdp.evaluate(`Array.from(document.querySelectorAll(".settings-categories > button"))
    .find((button) => button.textContent.includes("维护"))
    ?.click()`)
  await delay(40)
  results.automaticUpdateCheck = await cdp.evaluate(`(() => {
    const panel = document.querySelector("#settings-panel-maintenance");
    const preference = panel?.querySelector(".settings-update-preference");
    const preferenceCopy = preference?.querySelector(":scope > span");
    const checkbox = panel?.querySelector(
      '.settings-update-preference input[type="checkbox"]'
    );
    const updateRow = panel?.querySelector(".settings-update");
    const manualButton = Array.from(panel?.querySelectorAll(".settings-update button") ?? [])
      .find((button) => button.textContent?.includes("检查更新"));
    if (
      !(preference instanceof HTMLElement) ||
      !(preferenceCopy instanceof HTMLElement) ||
      !(checkbox instanceof HTMLInputElement)
    ) {
      return { visible: false };
    }
    const checkboxRect = checkbox.getBoundingClientRect();
    const preferenceCopyRect = preferenceCopy.getBoundingClientRect();
    const preferenceRect = preference.getBoundingClientRect();
    const initiallyChecked = checkbox.checked;
    checkbox.click();
    const checkedAfterDisable = checkbox.checked;
    checkbox.click();
    return {
      visible: panel instanceof HTMLElement && !panel.hidden,
      initiallyChecked,
      checkedAfterDisable,
      checkedAfterRestore: checkbox.checked,
      manualActionPresent: Boolean(manualButton),
      checkboxAfterCopy: Boolean(
        preferenceCopy.compareDocumentPosition(checkbox) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      checkboxAtRowEnd:
        checkboxRect.left > preferenceCopyRect.right &&
        Math.abs(preferenceRect.right - checkboxRect.right) <= 1,
      decorativeUpdateIconRemoved: !updateRow?.querySelector(".settings-update__icon")
    };
  })()`)
  assert(
    results.automaticUpdateCheck.visible &&
      results.automaticUpdateCheck.initiallyChecked &&
      !results.automaticUpdateCheck.checkedAfterDisable &&
      results.automaticUpdateCheck.checkedAfterRestore &&
      results.automaticUpdateCheck.manualActionPresent &&
      results.automaticUpdateCheck.checkboxAfterCopy &&
      results.automaticUpdateCheck.checkboxAtRowEnd &&
      results.automaticUpdateCheck.decorativeUpdateIconRemoved,
    `Automatic update preference is not wired to the settings UI: ${JSON.stringify(results.automaticUpdateCheck)}`
  )
  await cdp.evaluate(`(() => {
    const authorInput = document.querySelector(
      'input[aria-label="默认提交作者名"]'
    );
    const emailInput = document.querySelector(
      'input[aria-label="默认提交邮箱"]'
    );
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(authorInput, "Client Default");
    authorInput?.dispatchEvent(new Event("input", { bubbles: true }));
    setter?.call(emailInput, "client-default@example.com");
    emailInput?.dispatchEvent(new Event("input", { bubbles: true }));
  })()`)
  await cdp.evaluate(`document.querySelector(".settings-dialog .task-dialog__header > button")?.click()`)
  await delay(40)
}
