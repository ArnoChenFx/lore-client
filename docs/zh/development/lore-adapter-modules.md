# Lore 适配器模块

`src-tauri/src/lore_adapter.rs` 是 Tauri 壳与固定 Lore Rust API 之间的稳定适配门面。门面只保留共享状态、事件桥、IPC DTO 与结构化错误；具体命令和支撑逻辑位于 `src-tauri/src/lore_adapter/`。

## 命令模块

| 模块 | 职责 |
| --- | --- |
| `auth.rs` | 运行时信息、认证账户、仓库账户绑定和认证上下文刷新 |
| `repository.rs` | 仓库探测、初始化、发布、克隆、状态、共享存储、锁、依赖、通知、配置入口与 View 入口 |
| `history.rs` | Revision 历史拓扑、元数据、详情、查找、Amend、Bisect 与 Restore |
| `branch.rs` | Branch 查询、保护、Diff、Reset 和精确来源创建 |
| `composition.rs` | 标签、Layer 与 Link 命令 |
| `maintenance.rs` | Verify、Dump、Instance、远端信息和 GC |
| `workspace.rs` | Stage、工作区 Diff、Revision 文件读取、预览、文件历史、外部工具、补丁和忽略规则 |
| `operations.rs` | Commit、Sync、Push、Checkout、Cherry-pick、Revert、Merge、冲突、归档与工作区定位 |

这些模块使用 `pub(crate)`，使 `lib.rs` 能直接注册 `#[tauri::command]` 生成的函数和隐藏宏。命令函数名没有变化，因此前端 IPC 契约保持不变。

## 支撑模块

| 模块 | 职责 |
| --- | --- |
| `tags.rs` | 标签元数据读写、校验和去重 |
| `repository_lifecycle.rs` | 仓库探测、初始化、发布、缓存释放和元数据目录解析 |
| `view.rs` | View 规则解析、预览、应用、撤除与失败回滚 |
| `configuration.rs` | 配置文件保真编辑、字段规范化与提交身份解析 |
| `runtime.rs` | 异步调度、重型读取收敛、公共参数校验、共享存储解析和错误映射 |
| `revision_storage.rs` | Revision Storage、Tree 遍历、Raw 内容读取、预览编码和结构化 Diff |
| `operation_support.rs` | Lore 事件捕获、流式摘要、冲突识别和结果封装 |
| `external_tools.rs` | 路径安全、外部 Diff/Merge、临时文件、补丁和忽略规则 |

支撑项默认只使用 `pub(super)` 暴露给 `lore_adapter` 父模块。父模块以私有导入连接兄弟模块，避免把实现细节扩散到整个 crate。

## 依赖规则

1. React 仍只通过 `src/services/lore.ts` 调用 IPC，不依赖 Rust 模块布局。
2. `src-tauri/src/lib.rs` 只注册命令，不放置 Lore 业务逻辑。
3. 跨领域共享 DTO 和结构化错误保留在根门面；仅单领域使用的结构体留在对应模块。
4. 新增命令时先选择现有领域模块，并同步在 `lib.rs` 注册；只有出现清晰且独立的新职责时才新增模块。
5. 支撑函数优先保持私有；确需跨领域复用时使用 `pub(super)`，不得为了测试方便改成 `pub(crate)` 或 `pub`。
6. `tests.rs` 作为根门面的子模块覆盖私有边界，测试名称继续使用英文。

## 回归基线

模块调整后应至少运行 `cargo test --manifest-path src-tauri/Cargo.toml`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo check --manifest-path src-tauri/Cargo.toml`、`bun test` 与 `bun run build`。新增 Tauri 命令时还应核对命令实现集合与 `generate_handler!` 注册集合，防止命令实现存在但未注册。
