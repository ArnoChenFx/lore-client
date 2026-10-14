# Lore Client 本地 E2E 环境

[English](../en/E2E_LOCAL_STACK.md) · [开发者指南](DEVELOPMENT.md)

本文说明如何在同一台机器上运行 Epic Games 的 Lore 服务器（`loreserver`）和 Lore 认证服务，然后针对它们运行 Lore Client 的实时测试。服务端与认证端都不做模拟。脚本位于 `scripts/e2e/`，所有生成的内容都放在 `LORE_E2E_HOME` 下（默认 `~/lore-e2e`），该目录必须位于仓库之外。

## 运行的组件

| 组件 | 脚本固定的版本 | 作用 |
| --- | --- | --- |
| `loreserver` | `ghcr.io/arnochenfx/lore-server:0.10.1`，linux/amd64 清单 `sha256:6dad04dc1280cfb3…`，上游修订 `95a9a834f18402cbacf43d43518c0ac771e029eb` | Lore 服务器：仓库、分支、存储、QUIC/gRPC 传输。 |
| `lore-auth-service` | [ArnoChenFx/lore-auth-service](https://github.com/ArnoChenFx/lore-auth-service) 的 `f257d43`（`lore-auth` 0.1.12，Bun） | 浏览器登录、RS256 JWT、JWKS、ReBAC 权限、管理 API。 |
| 测试客户端 | 本仓库的 `src-tauri` crate，`live_server_tests.rs` | 通过 Lore Client 的后端适配层驱动上述环境。 |

`loreserver` 不是从源码构建的。`setup-stack.sh` 通过 GHCR 注册表 API 读取镜像，校验清单摘要和每个 blob 的摘要，然后解出 `usr/local/bin/loreserver`。不需要 Docker。0.10.1 二进制的 sha256 为 `f6495aeedb807d9d181e3256ee022d6680eda0ed31766a6595594e7205757d51`。

该镜像由 GHCR 上的 `arnochenfx` 账号发布，而不是 Epic Games。它的 `org.opencontainers.image.source` 标签指向 `EpicGames/lore`，但 `org.opencontainers.image.title` 标签是 `lore-auth-service`，描述和 URL 也属于认证服务。因此镜像元数据在这里并不可靠，真正标识二进制的是摘要固定。

```text
Lore Client 测试 ──lore://127.0.0.1:41337（gRPC/TCP，QUIC/UDP）──► loreserver
       │                                                              │
       │ 登录：xdg-open 垫片批准会话                                   │ auth_url、JWKS、ReBAC
       ▼                                                              ▼
    https://127.0.0.1:8080（登录、REST 管理、JWKS） ◄─────────► https://127.0.0.1:50051（gRPC）
                                 lore-auth-service
```

## 端口

| 端口 | 协议 | 监听者 |
| --- | --- | --- |
| 41337 | TCP | `loreserver` gRPC（`lore://`） |
| 41337 | UDP | `loreserver` QUIC |
| 41339 | TCP | `loreserver` HTTP 监听（`[server.http]`） |
| 8080 | TCP，TLS | `lore-auth-service` 登录页面、REST API、`/.well-known/jwks.json`、`/health_check` |
| 50051 | TCP，TLS | `lore-auth-service` gRPC（`epic_urc.UrcAuthApi`、`ucs.auth.RebacApi`） |

所有监听都通过生成的 `stack.toml` 与 `auth.env` 绑定到 `127.0.0.1`。如需修改，请使用下面的变量。查看监听情况可运行 `netstat -ltnup`；未安装 `netstat` 时，`ss -ltnup` 显示相同的信息。

## 前置条件

- Linux x86_64，并具备 `bash`、`git`、`curl`、`openssl` 1.1.1 或更高版本、`python3` 3.9 或更高版本，以及 `sed`。
- [Bun](https://bun.sh) 1.4 或更高版本，用于 `lore-auth-service`。
- 能访问 `ghcr.io`（镜像层约 100 MB）和 `github.com`（克隆认证服务）。
- 运行实时测试需要 Rust 工具链以及 Tauri 的 Linux 构建依赖，参见 [DEVELOPMENT.md](DEVELOPMENT.md)。
- 仅运行打包应用检查时需要：`tauri-driver`（`cargo install tauri-driver --locked`）、`WebKitWebDriver`（软件包 `webkit2gtk-driver`），以及一个正在运行的 X 显示器。

## 设置与启动

```bash
scripts/e2e/setup-stack.sh     # 首次运行时下载镜像，之后复用 bin/loreserver
scripts/e2e/start-stack.sh     # 启动两个服务，等待它们就绪，并创建 alice 与 bob
```

`setup-stack.sh` 是幂等的。重复运行时，它会保留 CA、服务器证书、认证签名密钥、管理员密码和测试用户密码。它会重新生成 `stack.toml`、信任包和 `xdg-open` 垫片，因此环境变量中修改的端口会生效；它还会收紧先前运行留下的认证状态的文件权限。

`start-stack.sh` 在 `umask 077` 下运行两个服务，因此认证数据库、签名密钥和日志都以私有权限创建。它把 PID 文件写入 `$LORE_E2E_HOME/run/`，把日志写入 `$LORE_E2E_HOME/logs/auth.log` 和 `server.log`。如果任一服务在超时时间内没有响应，它以非零状态退出。要停止环境：

```bash
scripts/e2e/stop-stack.sh
```

`setup-stack.sh` 和 `start-stack.sh` 都会打印进度信息，且从不打印机密值。

### 设置项

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LORE_E2E_HOME` | `~/lore-e2e` | 环境的主目录。必须位于仓库之外，否则脚本拒绝运行。 |
| `LORE_E2E_HOST` | `127.0.0.1` | 绑定地址和对外公布的主机名。修改后需要删除 `tls/server.pem`，以便重新生成证书。 |
| `LORE_E2E_SERVER_PORT` | `41337` | `loreserver` 的 gRPC（TCP）和 QUIC（UDP）。 |
| `LORE_E2E_SERVER_HTTP_PORT` | `41339` | `loreserver` 的 HTTP 监听。 |
| `LORE_E2E_AUTH_PORT` | `8080` | `lore-auth-service` 的 HTTPS。 |
| `LORE_E2E_AUTH_GRPC_PORT` | `50051` | `lore-auth-service` 的 gRPC。 |
| `LORE_SERVER_TAG` | `0.10.1` | 要解出的镜像标签。修改后请删除 `bin/loreserver`。 |
| `LORE_SERVER_DIGEST` | `sha256:6dad04dc…` | linux/amd64 清单所需的摘要。若要跳过摘要固定，请将其设为空值（`LORE_SERVER_DIGEST=`）。 |
| `LORESERVER_BIN` | 未设置 | 复制本地的 `loreserver` 二进制，而不是拉取镜像。 |
| `LORE_AUTH_SERVICE_REF` | `f257d43` | 要检出的 `lore-auth-service` 提交。 |
| `LORE_AUTH_SERVICE_DIR` | `$LORE_E2E_HOME/src/lore-auth-service` | 已存在的检出目录，用于替代克隆。 |
| `LORE_E2E_SYSTEM_CA_BUNDLE` | `/etc/ssl/certs/ca-certificates.crt` | 与 E2E CA 合并的系统根证书。 |
| `RUST_LOG` | `info` | `loreserver` 的日志级别。 |

### 信任

Lore Client 的 TLS 使用 `rustls-native-certs`。设置了 `SSL_CERT_FILE` 时，它读取该文件而不是系统证书库。因此脚本会基于系统根证书加上本地 CA 生成 `tls/trust-bundle.pem`，并且只为 `loreserver` 进程和测试运行导出 `SSL_CERT_FILE`。不会把任何内容安装到系统信任库中。

## 测试用户

`seed-users.py` 通过管理 API 创建两个非管理员用户 `alice` 和 `bob`。他们的密码位于 `$LORE_E2E_HOME/auth/users.env`，管理员密码位于 `$LORE_E2E_HOME/auth/auth.env`。这两个文件的权限都是 600。

## 运行实时测试

```bash
scripts/e2e/run-live-tests.sh                    # 串行运行全部十个实时测试
scripts/e2e/run-live-tests.sh live_conflicting   # 按名称前缀运行一个测试
```

运行器会设置 `LORE_E2E_SERVER`、`$LORE_E2E_HOME/work/` 下的临时目录、`LORE_E2E_SHIM_DIR` 和 `SSL_CERT_FILE`，然后执行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib live_ -- --ignored --test-threads=1 --nocapture
```

`--nocapture` 会保留每个测试输出的证据行（耗时、计数、文件路径）。务必串行运行：登录状态和 Lore 运行时都是进程级的。测试带有 `#[ignore]`，因此 `cargo test` 仍然保持离线。

### 浏览器登录

测试本身不驱动浏览器。当客户端通过 `xdg-open` 打开登录 URL 时，`$LORE_E2E_HOME/bin/xdg-open` 代替桌面浏览器。它从该 URL 读取 `session_code` 和 `client_state`，并以测试用户的身份批准会话，发送的请求与真人在登录表单中提交的相同。用户来自 `LORE_E2E_LOGIN_USER`（默认 `alice`），密码来自 `LORE_E2E_LOGIN_PASSWORD` 或 `users.env`。每次调用都会记录到 `$LORE_E2E_HOME/logs/xdg-open-shim.log`，内容为登录页路径加 HTTP 状态码，不包含会话码或密码。

设置 `LORE_E2E_SHIM_DISABLE=1` 后，垫片会记录 `shim disabled, not approving` 并退出，而不批准会话，因此登录无法完成。`run-live-tests.sh` 会把垫片放在 `PATH` 的最前面；如果客户端以其他方式打开 URL，就不会经过垫片。

### 测试矩阵

| 实时测试 | 针对真实服务器和认证服务检查的内容 |
| --- | --- |
| `live_login_publish_clone_push_and_sync_round_trip` | 通过认证服务完成浏览器登录，然后发布、克隆、提交、推送和同步。 |
| `live_clone_and_publish_report_progress_that_matches_the_transferred_bytes` | 48 MiB 发布和克隆的进度事件与实际传输的字节数及分片数一致。 |
| `live_stage_and_commit_progress_counts_every_file` | 对 200 个目录中的 20,000 个文件，暂存和提交进度计入每一个文件。 |
| `live_wrong_access_token_is_rejected_by_the_auth_service` | 错误的访问令牌被拒绝。 |
| `live_wrong_password_interactive_login_fails_instead_of_signing_in` | 错误的密码会导致登录失败，且不会登录成功。 |
| `live_unreachable_server_fails_without_hanging` | 没有服务器监听时，操作在有限时间内失败。 |
| `live_repository_list_requires_authentication_without_an_identity` | 没有身份时拒绝列出仓库，在隔离的子进程中执行。 |
| `live_conflicting_edits_resolve_through_external_merge_and_push` | 冲突会话、外部合并回写、拒绝过期的解决结果，然后完成暂存、提交、推送和同步。 |
| `live_loreignore_rule_hides_matching_files_from_status` | 追加到 `.loreignore` 的规则会从状态中隐藏匹配的文件，并让其他文件保持待处理。 |
| `live_repository_config_edit_is_read_back_by_the_runtime_and_stays_inside_the_repository`（Unix） | 写入 `.lore/config.toml` 的身份和远端能被运行时读回。指向仓库之外的 `config.toml` 符号链接会以 `repository_file_outside_repository` 被拒绝，且其指向的文件保持不变。 |

离线测试覆盖相同的领域，但不需要服务器。`runtime_e2e_tests.rs` 中有五个测试，覆盖外部合并回写的范围限制、符号链接拒绝和补丁目标。使用 `cargo test --manifest-path src-tauri/Cargo.toml --lib` 运行。

## 打包应用检查（WebDriver）

`scripts/e2e/packaged-app-check.mjs` 通过 `tauri-driver` 运行构建好的桌面二进制。它不登录，也不打开仓库，不需要正在运行的环境。它检查：

- 已移除的 IPC 命令（`lore_file_preview`、`lore_open_patch`）没有注册，并且每个前端命令名都出现在 Rust 处理器列表中；
- 通过真实的 `lore_write_patch_file` 处理器完成补丁导出，共七种情况：扩展名检查、新文件、未确认时拒绝覆盖（`patch_destination_exists`）、确认后替换、拒绝符号链接（`patch_destination_is_link`）且其目标保持不变、从不创建悬空链接、空补丁；
- 设置对话框从其懒加载代码块中加载；
- 未打开仓库时，仓库工具对话框被报告为跳过；
- 通过 `plugin:event|emit` 注入的进度快照会出现在状态栏中，且只有在 15 秒内没有新快照时才出现停滞提示。该快照是合成的，因此这里检查的是前端的停滞处理，而不是真实的暂存。

```bash
bun run tauri build --debug --no-bundle    # 构建 src-tauri/target/debug/lore-client
export DISPLAY=:1                          # 一个 X 服务器，例如 Xvfb :1
tauri-driver --port 4444 &
node scripts/e2e/packaged-app-check.mjs    # 截图保存到 $E2E_EVIDENCE_DIR
```

## 浏览器驱动检查（CDP 冒烟，仅前端）

`bun run test:ui` 运行 `scripts/cdp-smoke.mjs`。它驱动无头 Chrome 访问端口 1420 上的 Vite 开发服务器，只覆盖前端行为，不包含 Tauri 后端。其断言期望中文界面文本，因此请使用 zh_CN 区域设置运行：

```bash
LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 bun run test:ui
```

设置 `LORE_CLIENT_BROWSER_PATH` 可指定特定的 Chrome 或 Chromium。设置 `LORE_CDP_SCREENSHOT_DIR` 后，失败的懒加载视图状态会保存为 `cdp-lazy-view-failure.png`。

## `LORE_E2E_HOME` 的目录结构

```text
bin/loreserver           解出的服务器二进制
bin/xdg-open             登录批准垫片
auth/auth.env            认证服务设置，包括 ADMIN_PASSWORD（0600）
auth/users.env           测试用户凭据（0600）
auth/keys/               认证服务生成的 RS256 签名密钥（private.pem 为 0600）
auth/lore-auth.db        认证服务的 SQLite 数据库（用户、权限、会话）
server/config/stack.toml loreserver 配置
server/data/             测试创建的仓库
src/lore-auth-service/   LORE_AUTH_SERVICE_REF 所指认证服务的检出目录
tls/                     本地 CA、服务器证书和私钥、trust-bundle.pem
logs/                    auth.log、server.log、xdg-open-shim.log
run/                     start-stack.sh 写入的 PID 文件
work/                    实时测试运行的临时目录
```

要从空状态重新开始，请运行 `stop-stack.sh`，然后删除 `server/data/`（这会删除所有测试仓库），或者删除整个主目录。

## 安全说明

- 密钥、密码和令牌保存在 `auth/` 和 `tls/` 下，目录权限为 0700，文件权限为 0600。`start-stack.sh` 在 `umask 077` 下运行服务，`setup-stack.sh` 会收紧先前运行留下的权限。如果主目录位于仓库内，`setup-stack.sh` 拒绝运行。不要把这些文件复制到仓库或 CI 日志中。
- 此环境仅用于测试，使用生成的本地 CA 和生成的测试密码。不要把端口 41337、41339、8080 或 50051 暴露到回环地址之外。
- 垫片会批准它被要求批准的任何登录，因此只能把 `xdg-open` 指向此环境。

## 被测环境中的已知问题

以下问题都是在此环境中复现的。它们属于 `lore-auth-service` 和镜像，而不是本仓库，本仓库不会修改它们。`scripts/e2e/auth-service-probes.mjs` 可在运行中的环境上复现第 1 至 4 项。它只打印状态码和计数，并会创建 `probe-*` 用户。

1. `/auth/login` 没有尝试次数限制。连续三十次错误密码都返回 401，随后正确密码返回 200。
2. 批准锁定是按会话计算的。`AUTH_SESSION_MAX_ATTEMPTS`（默认 5）次失败批准后，该会话会被锁定 `AUTH_SESSION_LOCK_SECONDS`（默认 60）秒，同一会话中即使输入正确密码也会被拒绝。gRPC 端口上的 `StartAuthSession` 不需要任何凭据，因此每个新会话都从未锁定状态开始：十个新会话中的十次错误密码都被以无效凭据拒绝，随后在新会话中输入正确密码即被接受。
3. 请求体大小限制。`parseJsonBody` 会拒绝 `Content-Length` 超过 64 KiB 的请求，处理器随后返回 `400 Missing username or password`，即使密码正确。没有 `Content-Length`（分块传输）的请求会被完整读取，因此同样的超大请求体会进入密码校验（错误密码 401，正确密码 200）。这个上限只对声明了长度的客户端生效。
4. 已删除用户的访问令牌在过期前仍然有效。默认 `TOKEN_TTL` 为 10 天，用户删除后 `/auth/me` 仍返回 200，而 `/auth/refresh` 返回 401。刷新令牌和权限通过 `ON DELETE CASCADE` 被删除。
5. `ADMIN_PASSWORD` 默认为 `changeme`。服务只在启动时输出一条 `[security]` 警告日志。
6. `lore-server:0.10.1` 镜像的标签指向认证服务（参见“运行的组件”）。

## 故障排查

- `lore-auth-service did not answer` 或 `loreserver did not open`：阅读 `logs/auth.log` 或 `logs/server.log`。端口可能已被占用，可用 `netstat -ltnup` 检查。
- 客户端或认证服务报证书错误：确认 `tls/trust-bundle.pem` 以 E2E CA 结尾，并且 `tls/server.pem` 与 `LORE_E2E_HOST` 匹配。
- 登录挂起并超时：阅读 `logs/xdg-open-shim.log`。没有记录说明客户端没有调用垫片，这通常是因为 `LORE_E2E_SHIM_DIR` 不在 `PATH` 的最前面。`run-live-tests.sh` 会为你设置它。
- `start-stack.sh` 报 `admin login failed`：`auth/auth.env` 中的管理员密码与数据库不匹配。当数据库是用另一个密码创建时会出现这种情况。恢复旧值，或删除 `auth/lore-auth.db` 重新开始。
