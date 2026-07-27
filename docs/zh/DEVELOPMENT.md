# Lore Client 开发者指南

[English](../en/DEVELOPMENT.md) · [用户说明](README-zh.md)

本文提供从全新检出到完成合格贡献的最短路径。产品功能请阅读用户说明。

## 快速开始

### 环境要求

请安装：

- Bun 1.3 或更高版本。
- Rust stable 工具链与 Cargo。
- Git LFS 3.x。
- Tauri 所需的平台依赖：Windows 使用 WebView2 与 Windows 构建工具，Linux 使用 WebKitGTK 4.1 开发包，macOS 使用 Xcode Command Line Tools。

安装锁定版本的依赖：

```powershell
git lfs install
git lfs pull
bun install --frozen-lockfile
```

### 选择开发模式

界面开发优先使用浏览器预览：

```powershell
bun run dev
```

预览地址为 `http://127.0.0.1:1420`，其中使用样例数据。涉及真实仓库、原生对话框、文件系统访问或 Lore 操作时，请使用桌面应用：

```powershell
bun tauri dev
```

创建生产前端构建或验证桌面壳：

```powershell
bun run build
bun tauri build --debug --no-bundle
```

## 找到正确的修改位置

| 任务 | 主要位置 |
| --- | --- |
| 应用级界面、外壳与弹层 | `src/app/`、`src/App.tsx`、`src/styles.css` |
| Revision、本地更改、分支等领域界面与工作流 | `src/features/<domain>/` |
| 跨领域基础控件与纯函数 | `src/shared/ui/`、`src/shared/lib/` |
| 前端稳定数据类型 | `src/types.ts` |
| 前端 Lore 调用 | `src/services/lore.ts` |
| 原生 Lore 操作 | `src-tauri/src/lore_adapter.rs`、`src-tauri/src/lib.rs` |
| 偏好与持久化布局 | `src/services/preferences.ts`、`src/hooks/` |
| 中英文界面文案 | `src/i18n/locales/` |
| 浏览器预览样例数据 | `src/data.ts` |
| UI 与视觉验收 | `scripts/` |
| 公共文档与图片 | `README.md`、`docs/en/`、`docs/zh/`、`docs/img/` |

不得提交生成的依赖、构建产物、Rust target、临时浏览器配置或生成的分析目录。

## 常见开发任务

### 修改界面

先运行 `bun run dev`，修改对应组件与共享样式，再补充或更新邻近的 Vitest 测试。使用语义化设计令牌，确保同一改动同时适用于深色与浅色主题。

所有用户可见文案、可访问名称、提示、确认和错误信息都必须使用多语言资源。英文与简体中文资源必须同步更新。

领域组件与其测试放在对应的 `src/features/<domain>/components/` 中；应用外壳组件放在
`src/app/components/`。跨领域调用应从领域根目录的 `index.ts` 入口导入，不要依赖
另一个领域的内部 `components/` 路径；只有被多个领域真实复用的控件和纯函数才能进入
`src/shared/`。

### 新增或修改 Lore 能力

保持统一的接入路径：

1. 在 `src/types.ts` 中定义或更新稳定前端 DTO。
2. 在 `src/services/lore.ts` 中增加前端操作。
3. 将功能状态与工作流编排放入对应的 `src/features/<domain>/` 模块，由
   `src/app/` 组合其窄接口控制器，并让 `src/App.tsx` 保持为应用根。
4. 在 `src-tauri/src/lore_adapter.rs` 中实现原生命令，并在 `src-tauri/src/lib.rs` 中注册。
5. 返回可由界面本地化的结构化结果与错误。
6. 根据行为补充前端与 Rust 测试。

桌面模式必须呈现真实失败。Lore 操作失败时，不得改用样例数据或报告成功。

### 修改持久化设置

持久化设置统一使用偏好服务和 `client-preferences.json` 流程，不得新增运行期 `localStorage` 写入。

### 记录运行日志

前端统一使用 `src/services/logging.ts`，不要新增零散的 `console.error`。Lore IPC
统一经过 `invokeLogged`；只记录命令名、耗时和结果，禁止序列化参数、Token DTO
或文件内容。错误文本必须经 `sanitizeLogMessage` 脱敏。

Rust 日志、轮转与日志目录命令集中在 `src-tauri/src/app_logging.rs`。日志落到
Tauri `AppLog` 目录，单文件 5 MiB，总共保留 5 个活动或轮转文件。修改日志边界时必须
补充脱敏测试，并确认 `src-tauri/capabilities/default.json` 仍只授予必要权限。

### 连接 Lore 服务器

启动桌面应用前显式设置服务器地址：

```powershell
$env:VITE_LORE_SERVER_URL = "lore://server.example:41337"
bun tauri dev
```

显式联网测试使用同一个环境变量。默认测试集必须保持离线。

### 更新公共文档

中英文公共文档必须同步维护。公共图片统一放入 `docs/img/`，新增或替换后确认图片由 Git LFS 管理：

```powershell
git check-attr filter -- docs/img/example.png
git lfs ls-files
```

## 项目边界

以下规则保护最重要的跨模块行为：

- React 组件依赖 `src/types.ts` 中的稳定 DTO，不直接依赖 Lore Rust 或 C 类型。
- 前端 Lore 操作统一经过 `src/services/lore.ts`；原生校验与仓库操作保留在 `src-tauri`。
- 用户可见文案在两种支持语言中同步本地化。
- 仓库写操作必须保留真实状态并明确呈现失败；破坏性操作需要清晰的用户确认。
- 应用持久化偏好统一使用共享偏好流程。
- 对外用户文档与开发者文档保持中英文同步。
- 不覆盖工作区中与当前任务无关的已有修改。

## 验证改动

根据修改的文件和行为选择对应检查。

| 改动类型 | 必需检查 |
| --- | --- |
| 仅文档 | 检查链接和双语一致性；运行 `git diff --check` |
| 前端逻辑或组件 | `bun run check`、`bun test`、`bun run lint`、`bun run format:check`、`bun run build` |
| Rust 或 Lore 适配层 | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo check --manifest-path src-tauri/Cargo.toml`，以及针对性 Rust 测试 |
| 桌面权限、壳或打包 | `bun tauri build --debug --no-bundle` |

交付前的基础检查为：

```powershell
bun test
bun run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

提交到仓库的测试必须能在所有支持的平台独立、稳定复现。使用临时目录、夹具、mock
或依赖注入代替真实仓库、本地服务、已安装浏览器、个人账户、墙钟性能阈值和机器特定
路径。测试套件和测试用例统一使用英文名称。

## 提交拉取请求前

- 检查 `git status` 与最终差异，只纳入和当前改动相关的文件。
- 保持中英文界面文案与公共文档同步。
- 为行为变更补充测试，并记录无法执行的检查。
- 确认公共图片通过 Git LFS 保存。
- 不提交生成产物或临时浏览器数据。
- 正式发布时，保持 Git 标签、`package.json`、Tauri 配置和 Cargo 包版本一致。

## 常见问题

- **1420 端口已占用：** 复用已有 Vite 进程，或只停止明确占用该端口的进程。
- **浏览器预览正常但桌面模式失败：** 使用 `bun tauri dev` 复现；浏览器样例数据不会执行原生仓库操作。
- **本地操作正常但服务器操作失败：** 检查 `VITE_LORE_SERVER_URL`、网络、权限和 Lore 服务兼容性。
- **文档图片被保存为普通 Git 对象：** 运行 `git lfs install`，再检查 `.gitattributes` 和 `git check-attr filter`。
