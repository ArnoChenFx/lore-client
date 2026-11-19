# Lore Client 开发者指南

[English](../en/DEVELOPMENT.md) · [用户说明](README-zh.md)

本文提供从全新检出到完成合格贡献的最短路径。产品功能请阅读用户说明。

## 快速开始

### 环境要求

请安装：

- Bun 最新稳定版（CI 使用 `bun-version: latest`）。
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
| 前端 Lore 调用 | `src/services/lore/` |
| 原生 Lore 操作 | `src-tauri/src/lore_adapter.rs`、`src-tauri/src/lib.rs` |
| Revision 作者离线显示缓存 | `src-tauri/src/revision_author_cache.rs`、`src/services/lore/` |
| 偏好与持久化布局 | `src/services/preferences.ts`、`src/hooks/` |
| 中英文界面文案 | `src/i18n/locales/` |
| 浏览器预览样例数据 | `src/data.ts` |
| UI 与视觉验收 | `scripts/` |
| 公共文档与图片 | `README.md`、`docs/en/`、`docs/zh/`、`docs/img/` |

不得提交生成的依赖、构建产物、Rust target、临时浏览器配置或生成的分析目录。

`bun run test` 使用 Bun 的 `--isolate` 模式，隔离各测试文件的模块替身与全局状态。本地开发与 CI 均使用该脚本，以应用相同的隔离设置。

## 常见开发任务

### 修改界面

先运行 `bun run dev`，修改对应组件与共享样式，再补充或更新邻近的 `bun run test` 测试。使用语义化设计令牌，确保同一改动同时适用于深色与浅色主题。

所有用户可见文案、可访问名称、提示、确认和错误信息都必须使用多语言资源。英文与简体中文资源必须同步更新。

领域组件与其测试放在对应的 `src/features/<domain>/components/` 中；应用外壳组件放在
`src/app/components/`。跨领域调用应从领域根目录的 `index.ts` 入口导入，不要依赖
另一个领域的内部 `components/` 路径；只有被多个领域真实复用的控件和纯函数才能进入
`src/shared/`。

### 新增或修改 Lore 能力

保持统一的接入路径：

1. 在 `src/types.ts` 中定义或更新稳定前端 DTO。
2. 在 `src/services/lore/` 对应的领域模块中增加前端操作。
3. 将功能状态与工作流编排放入对应的 `src/features/<domain>/` 模块，由
   `src/app/` 组合其窄接口控制器，并让 `src/App.tsx` 保持为应用根。
4. 在 `src-tauri/src/lore_adapter.rs` 中实现原生命令，并在 `src-tauri/src/lib.rs` 中注册。
5. 返回可由界面本地化的结构化结果与错误。
6. 根据行为补充前端与 Rust 测试。

桌面模式必须呈现真实失败。Lore 操作失败时，不得改用样例数据或报告成功。

### 升级固定 Lore 版本

上游升级通常同时改动 C API、FFI 错误码与协议语义，按以下顺序处理：

1. 把 `src-tauri/Cargo.toml` 中 `lore` 与 `lore-revision` 的 `rev` 同时改成目标标签
   指向的 commit（两行必须一致，否则协议实现漂移）。
2. 对比上游 `Cargo.toml` 的 `[patch.crates-io]`：上游作为外部 Git 依赖时 path
   patch 不传播，每一条都需要在客户端侧携带同一份 vendored crate 并加入本地
   patch 表。当前包含 `vendor/quinn-proto` 与 `vendor/glob-match`。
3. 逐项比对 `lore-base/src/error.rs` 的 `#[ffi_code(N)]` 分配表与
   `src-tauri/src/lore_adapter/runtime.rs` 的 `lore_error_code_name`，以及
   `LORE_FFI_ERROR_NOT_AUTHENTICATED` / `LORE_FFI_ERROR_NOT_CONNECTED` 常量与
   前端 `localizedLoreErrorCodeKey`。错误码换位不会报编译错误，但会让错误分类
   静默失效。
4. `cargo check` 会报出结构体字段增删；逐个确认新字段的语义后再决定填充值，
   不得为了通过编译而无脑传默认值（尤其是此前会改变行为的新开关）。
   同时运行 `cargo check --tests`：测试代码会直接构造事件结构体，新增字段会先在这里暴露。
5. 阅读依赖的 `build.rs` 与原生链接输入。新增的预编译库（v0.14.0 在 Windows 上新增了静态
   SWFS 库）会改变桌面二进制的链接内容，需要运行 `bun tauri build --debug --no-bundle` 并查看链接器警告。
6. 事件 JSON 并不能完全从 `lore.h` 看出：有些类型自己决定序列化方式（`InstanceId` 是
   `{ "data": [16 个字节] }`，不是十六进制字符串）。运行当前固定版本章节里点名的、默认被忽略的
   真实 Lore 契约测试，并比对真实事件与前端解析器。

### 内嵌 Lore v0.14.0

两个 Lore 依赖均固定到官方 `v0.14.0` 标签的提交
`317f48b918f0b4d43de104d99e80ac4a57b697df`，原版本为 `v0.13.0`
（`9e0b4519a8a246e471d01853955f63bf0cecbeca`）。标签内 workspace 声明的版本为
`0.13.1-nightly`，发布版本以源码提交号为准；此次升级不包含 main 上未发布的变更。
vendored 的 `glob-match` 与 `quinn-proto` 与标签一致，上游 `[patch.crates-io]` 清单不变，
FFI 错误码表与 v0.13.0 完全相同。

客户端影响与适配：

- **推送进度。** Push 事件（片段开始/进度/结束、Revision 推送、分支创建）现在都以所属的
  `repository` 与 `branch` 起头，而且 `lore push` 最多同时上传 8 个目标（主仓库、layer、
  link），不同目标的事件会交错。进度改为按 `(repository, branch)` 分别记账再合计显示，界面
  消费的流形状不变；同一仓库的目标仍然一次只推一个。
- **被拒绝的请求。** 被服务器或认证服务拒绝的请求现在统一报 `NotAuthenticated`(16) 或
  `NotAuthorized`(17)，不再是内部错误、`NotConnected`(29) 或 not-found。16、17 与可重试的
  `SlowDown`(31) 配有本地化主文案并保留 Lore 的详情；`MountsBusy`(51) 已加入原生名称表。
  服务器对“无法验证的令牌”（过期、格式错误）只回复无区分的 `PermissionDenied`，无法与真正
  的无权限区分，所以 17 仍然**不**触发重新认证，而是在文案里提示到“账户”中重新认证。
- **锁查询。** Lore 在询问远端之前就拒绝同时给出 owner 与 path 的查询。原生命令先行拒绝
  （`lock_query_filters_conflict`），界面本来就不会发出这种组合；只给 path、不给 branch 时现在
  查询当前分支。
- **作者名解析。** 当 `local_user_info` 从仓库推导认证地址时，现在会先联网刷新已过期的登录，
  刷新被拒绝时还会删除已存的刷新令牌。适配层始终显式传入认证地址且不带仓库，走不到这条分支，
  必须保持这一点，否则作者名查询会访问网络并可能让登录失效。
- **已对照源码确认不受影响。** 分支元数据 `set`/`clear`（客户端只读元数据）、
  `instance move`/`delete`（未开放）、`branch create` 的零 id 与非法名称变化（客户端不传 id）、
  归档分支的 switch/reset/push 变化（归档项只读，库内 push 在远端分支被删时会自行重建）、
  严格的 `LORE_AUTH_STORE` 与 `config.toml` 校验（只有 CLI 入口调用，库内 token store 仍宽松
  读取）、`fast_flush`（默认关闭）以及 `stage` 的全局 `force`（从不设置）。
- **`lore.h` 之外的事件 JSON。** `InstanceId` 序列化为 `{ "data": [16 个字节] }`，不像
  分支和仓库 ID 那样是十六进制字符串（v0.13.0 就已如此）。`readInstanceId` 为实例列表和克隆
  结果做转换；旧的按字符串读取得到的是空 id，在列表里变成重复的 key。

新消费的能力：

- **克隆 Instance**（仓库工具 → 高级诊断）。`lore_repository_instance_clone` 先用 Lore 自己的
  dry run 预检，再克隆。只有使用共享 Store 的 Instance 才能克隆；目标必须不存在（在原生边界
  检查）；所在卷无法共享数据块时，Lore 拒绝，除非用户允许复制且空间足够。克隆会持有 Instance 与
  Store 的锁，因此经 Repository 写队列执行，并先弹出写明克隆方式的确认；进度事件会流式推送，
  预检则从不开流。
- **Instance 级忽略规则。** 本地更改 → 忽略 →“仅在此 Instance”会写入 `<Lore 目录>/ignore`
  （`.lore/ignore`，旧仓库为 `.urc/ignore`）。规则只对当前工作副本生效、只作用于未跟踪路径、
  从不提交，并且只能排除。

未采纳：FUSE 虚拟克隆（仅 Linux，且应用需要承载 `lore service run`；`LoreVfsType::Default`
现在在 Linux 上等于 FUSE，所以适配层必须继续固定传 `LoreVfsType::None`）、`--fast-flush`
（崩溃会丢弃该文件持有的全部索引条目，包括尚未推送的 Revision 与 Branch）、用户级
`config.toml` 的 `[auth]`、`lore-unix://` 远端，以及用 `branch create <name> --id <id>` 恢复归档
分支（它还会把工作区挂到恢复后的分支并停在原修订，需要单独设计界面）。

构建与测试注意：

- Lore v0.14.0 在 Windows x86-64 上链接一份预编译的静态 SWFS 库（`lore-revision/native/swfs`：
  dev 配置用 `swfs_d.lib`，release 用 `swfs.lib`）。它的构建脚本注明由二进制自己的
  `+crt-static` 提供 C 运行时，上游的 `.cargo/config.toml` 设置了它而本客户端没有。两种配置都能用
  本客户端的现有配置正常链接：唯一的痕迹是缺少 `swfs.pdb` 的链接警告 `LNK4099`（属预期），且二进制
  只导入系统 DLL（Universal CRT 的 API set），没有 VC 运行时 DLL。升级时需要重新核对。
- `lore-fuse` 仅限 Linux，直接使用 `/dev/fuse`，不需要任何系统库。
- `cargo test instance_clone_matches_the_real_lore -- --ignored --test-threads=1` 会驱动真实的
  共享 Store 仓库并核对前端解析的事件契约。每次升级 Lore 后都应运行；它通过
  `LORE_GLOBAL_PATH` 隔离 Lore 的全局状态，所以默认被忽略。

部署兼容性：分支元数据键 `archived`、`restored`、`restoring`、`released` 现在专属于归档与恢复。
应用此前存在这些键下的值，必须在升级 Lore Server 或库之前移除或改名；客户端从不写入它们。
中继给 Lore service 的调用多带一个变量，桌面客户端升级后应结束正在运行的 Lore service 进程。
Lore Server 的变化（mutable store 交换契约、`remote` 不可变存储默认信任上游、QUIC 请求失败日志
target）在升级服务端时才生效，本次不做。E2E 栈固定的 `0.10.1` 服务端不变，实际部署仍需联机
验证。

### 沿用自 v0.13.0 的行为

v0.13.0 升级时做过以下适配，对当前固定版本仍然成立：

- 交互登录新增 `reuse_session`，适配器显式设为 `0`，保留用户主动登录时打开认证、
  切换账户的行为。本地账户查询现在对已存储登录先发 `AuthUserToken`、再发
  `AuthUserInfo`；客户端仍将 `with_identity_token` 与 `with_access_token` 设为 `0`，
  因而新增事件不含 Token 字符串，显示名仍从 `AuthUserInfo` 提取。新增续期与会话字段
  不改变现有账户界面。
- 新增 FFI 错误码 `52`（`LinkDivergent`），已补齐 Rust 名称映射和中英恢复提示，
  保留上游 Link 路径、Branch 详情。认证相关的 `16`、`29` 含义不变，旧码没有重排。
- View/Ignore 按 gitignore 的路径组件及祖先目录规则匹配。选择性同步直接使用 Lore
  的 `Filter` 校验并计算预览，移除客户端重复实现。例如 `!/Engine/Content**` 不会
  包含该目录内的文件，应改用 `!/Engine/Content`。以 globstar 组件开头的重包含
  （包括 `!/**/a/b`）在应用 View 前被拒绝。vendored `glob-match` 已完整同步到标签；
  `quinn-proto` 与上游 patch 清单不变。
- 所有平台统一拒绝 Windows 会解析成其他对象的名称，包括尾随空格、尾随点、盘符及
  仓库控制目录别名。Stage/Unstage 在调用 Lore 前校验并返回本地化错误，避免表面成功
  却未暂存任何内容；合法名称的前导空格仍保留且彼此区分。现有不支持的名称需先重命名，
  才能由升级后的库跟踪。
- 已跟踪文件即使命中 Ignore 仍参与状态、暂存等操作。reset 同步及分支切换保留未跟踪
  文件；显式 reset purge 不受 Ignore 保护。客户端没有新增 purge 开关，也没有开放新
  Instance 移动/删除 API。上游另修复稀疏 View 暂存、Link 挂载与合并、历史分页、同步
  中断恢复，并优化同步、过滤器及存储性能。

部署兼容性需单独确认：`lores://` 服务器公布的各服务端点必须支持服务器身份验证
（如 `lores://`），否则连接报 `NotSupported`。升级 Lore Server 前，配置的 `user_url`
必须先提供 `lore.user.v1.RepositoryRegistryService`；旧 Partition RPC 已删除。
仓库写入、分支保护及预签名 URL 将执行新版权限检查。未配置 `user_url` 的服务器
无需目录服务迁移。本次仅更新客户端依赖，不升级运行中的服务器，也不改变 E2E 栈
固定的 `0.10.1` 服务端；实际部署仍需联机验证。桌面升级后应使用匹配构建重启外部
Lore service。

### 修改持久化设置

持久化设置统一使用偏好服务和 `client-preferences.json` 流程，不得新增运行期 `localStorage` 写入。

### 记录运行日志

前端统一使用 `src/services/logging.ts`，不要新增零散的 `console.error`。Lore IPC
统一经过 `invokeLogged`；只记录命令名、耗时和结果，禁止序列化参数、Token DTO
或文件内容。错误文本必须经 `sanitizeLogMessage` 脱敏。

### 连接 Lore 服务器

启动桌面应用前显式设置服务器地址：

```powershell
$env:VITE_LORE_SERVER_URL = "lore://server.example:41337"
bun tauri dev
```

显式联网测试使用同一个环境变量。默认测试集必须保持离线。

要针对本地 Lore 服务器和 lore-auth-service 运行实时测试，请参阅 [E2E_LOCAL_STACK.md](E2E_LOCAL_STACK.md)。

### 更新公共文档

中英文公共文档必须同步维护。公共图片统一放入 `docs/img/`，新增或替换后确认图片由 Git LFS 管理：

```powershell
git check-attr filter -- docs/img/example.png
git lfs ls-files
```

## 项目边界

以下规则保护最重要的跨模块行为：

- React 组件依赖 `src/types.ts` 中的稳定 DTO，不直接依赖 Lore Rust 或 C 类型。
- 前端 Lore 操作统一经过 `src/services/lore/`；原生校验与仓库操作保留在 `src-tauri`。
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
| 前端逻辑或组件 | `bun run check`、`bun run test`、`bun run lint`、`bun run format:check`、`bun run build` |
| Rust 或 Lore 适配层 | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo check --manifest-path src-tauri/Cargo.toml`，以及针对性 Rust 测试 |
| 桌面权限、壳或打包 | `bun tauri build --debug --no-bundle` |

交付前的基础检查为：

```powershell
bun run test
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
- **Windows 上 `cargo test` 以 `STATUS_ENTRYPOINT_NOT_FOUND`（`0xc0000139`）启动失败：** 测试程序缺少 Common Controls v6 清单。
  `tauri-plugin-dialog`（经 `rfd 0.17`）用 `TaskDialogIndirect` 弹消息框，这个函数只存在于 comctl32 v6，所以链接了它的任何程序
  都需要该清单。`tauri-build` 只把自带清单嵌入应用本体，因此 `build.rs` 关闭了这个默认行为
  （`WindowsAttributes::new_without_app_manifest`），改为用 `embed-resource` 的 `compile_for_everything` 把
  `windows-app-manifest.xml`（与 tauri-build 默认清单一致的副本）链接进所有目标。两处改动必须一起保留，同时存在会产生重复的清单
  资源。检查某个程序时运行 `mt.exe -inputresource:<exe>;#1 -out:<文件>`：应用与测试程序都应有且仅有一份相同的清单。如果以后
  `tauri-build` 自己把清单链接进所有目标，就可以删掉这个绕行方案。
