# Lore Client 本地 E2E 环境

[English](../en/E2E_LOCAL_STACK.md) · [开发者指南](DEVELOPMENT.md)

本文说明如何在同一台机器上运行 Epic Games 的 Lore 服务器（`loreserver`）和 Lore 认证服务，然后针对它们运行 Lore Client 的实时测试。服务端与认证端都不做模拟。脚本位于 `scripts/e2e/`，所有生成的内容都放在 `LORE_E2E_HOME` 下（默认 `~/lore-e2e`），该目录必须位于仓库之外。

**最近验证**：2026-10-14，Linux x86_64，lore-auth-service `f3742a7`、`loreserver` 0.10.1。在全新的认证数据库上，认证探针 12 项检查全部通过。实时测试尚未在 `f3742a7` 上运行：它们需要 Rust 1.85 或更高版本，而验证环境的 Rust 为 1.83；此前在 `b4be18d` 上的验证报告 10 个实时测试全部通过。结果和探针输出见 [认证服务中的问题](#认证服务中的问题) 与 [认证服务探针](#认证服务探针)。

## 运行的组件

| 组件 | 脚本固定的版本 | 作用 |
| --- | --- | --- |
| `loreserver` | `ghcr.io/arnochenfx/lore-server:0.10.1`，linux/amd64 清单 `sha256:6dad04dc1280cfb3…`，上游修订 `95a9a834f18402cbacf43d43518c0ac771e029eb` | Lore 服务器：仓库、分支、存储、QUIC/gRPC 传输。 |
| `lore-auth-service` | [ArnoChenFx/lore-auth-service](https://github.com/ArnoChenFx/lore-auth-service) 的 `f3742a7`，即 [PR #1](https://github.com/ArnoChenFx/lore-auth-service/pull/1) 的分支头（`lore-auth` 0.1.13，Bun） | 浏览器登录、RS256 JWT、JWKS、ReBAC 权限、管理 API、登录节流。 |
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
- [Node.js](https://nodejs.org) 18 或更高版本，用于 `scripts/e2e/auth-service-probes.mjs`。
- 能访问 `ghcr.io`（镜像层约 100 MB）和 `github.com`（克隆认证服务）。
- 运行实时测试需要 Rust 1.85 或更高版本，以及 Tauri 的 Linux 构建依赖，参见 [DEVELOPMENT.md](DEVELOPMENT.md)。上游 Lore crate 使用 edition 2024，`run-live-tests.sh` 会拒绝更旧的 `rustc`。
- 仅运行打包应用检查时需要：`tauri-driver`（`cargo install tauri-driver --locked`）、`WebKitWebDriver`（软件包 `webkit2gtk-driver`），以及一个正在运行的 X 显示器。

## 设置与启动

```bash
scripts/e2e/setup-stack.sh     # 首次运行时下载镜像，之后复用 bin/loreserver
scripts/e2e/start-stack.sh     # 启动两个服务，等待它们就绪，并创建 alice 与 bob
```

`setup-stack.sh` 是幂等的。首次运行时它会生成 `ADMIN_PASSWORD`，`lore-auth-service` 要求设置该变量（参见 [认证服务设置](#认证服务设置)）。重复运行时，它会保留 CA、服务器证书、认证签名密钥、管理员密码和测试用户密码。它会重新生成 `stack.toml`、信任包和 `xdg-open` 垫片，因此环境变量中修改的端口会生效；它还会收紧先前运行留下的认证状态的文件权限。

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
| `LORE_AUTH_SERVICE_REF` | `f3742a7` | 要检出的 `lore-auth-service` 提交。默认值为 PR #1 的分支头，其中包含修复。设为 `f257d43` 可复现问题。 |
| `LORE_AUTH_SERVICE_DIR` | `$LORE_E2E_HOME/src/lore-auth-service` | 已存在的检出目录，用于替代克隆。 |
| `LORE_E2E_SYSTEM_CA_BUNDLE` | `/etc/ssl/certs/ca-certificates.crt` | 与 E2E CA 合并的系统根证书。 |
| `RUST_LOG` | `info` | `loreserver` 的日志级别。 |

### 认证服务设置

`setup-stack.sh` 会写入 `auth/auth.env`，其中还设置监听地址、路径、TLS 文件、签发者（issuer）、受众（audience）和管理员用户名。下表列出管理员密码以及令牌、会话和登录节流相关的设置，并给出本环境使用的值。表中未列出的此类设置保持服务默认值，因此探针测试的就是默认配置。`setup-stack.sh` 每次运行都会重写 `auth.env`，所以请在运行 `start-stack.sh` 的环境中设置覆盖值，例如 `LOGIN_MAX_FAILURES_PER_IP=0 scripts/e2e/start-stack.sh`。

| 变量 | 环境中的值 | 服务默认值 | 用途 |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | 生成，48 个十六进制字符 | 无，必须设置 | 引导管理员的密码。缺失、少于 8 个字符，或为公开值 `changeme` 或 `replace-with-a-long-random-password` 时，服务拒绝启动，除非设置了 `ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD=true`。管理员首次创建时使用该值；之后的启动中，只有当已存储的管理员仍使用这两个公开值之一时才会使用。 |
| `ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD` | 服务默认值 | `false` | 仅用于本地开发。允许使用公开的 `changeme` 和 `replace-with-a-long-random-password`，并在未设置 `ADMIN_PASSWORD` 时将 `changeme` 作为默认值。本环境从不设置它。 |
| `TOKEN_TTL` | 服务默认值 | `864000`（10 天） | 访问令牌的有效期，单位为秒。 |
| `REFRESH_TOKEN_TTL` | 服务默认值 | `604800`（7 天） | 刷新令牌的有效期，单位为秒。 |
| `AUTH_SESSION_TTL` | `300` | `300` | 浏览器登录会话的有效期，单位为秒。 |
| `AUTH_SESSION_MAX_ATTEMPTS` | 服务默认值 | `5` | 单个浏览器会话中失败的批准次数，达到后该会话被锁定。 |
| `AUTH_SESSION_LOCK_SECONDS` | 服务默认值 | `60` | 单个浏览器会话的锁定时长。 |
| `LOGIN_MAX_FAILURES_PER_USER_IP` | 服务默认值 | `5` | 同一来源地址对同一用户名的密码失败次数，达到后锁定。`0` 关闭此维度。 |
| `LOGIN_MAX_FAILURES_PER_IP` | 服务默认值 | `100` | 同一来源地址在所有用户名上的密码失败次数，达到后锁定。`0` 关闭此维度。 |
| `LOGIN_MAX_FAILING_IPS_PER_ACCOUNT` | 服务默认值 | `50` | 15 分钟内对同一账号失败的不同来源地址数，达到后该账号对所有来源锁定。`0` 关闭此维度，`1` 会在启动时被拒绝。 |
| `LOGIN_LOCK_BASE_SECONDS` | 服务默认值 | `60` | 首次登录锁定时长，每次额外失败后翻倍。 |
| `LOGIN_LOCK_MAX_SECONDS` | 服务默认值 | `900` | 登录锁定时长的上限。 |
| `LOGIN_RECENT_SUCCESS_SECONDS` | 服务默认值 | `2592000`（30 天） | 在该时长内曾成功登录该账号的来源，不受该账号的锁定影响。设为 `0` 关闭此豁免。 |
| `TRUSTED_PROXY_COUNT` | 服务默认值 | `0` | 服务前面的反向代理层数。本环境没有代理，因此以 TCP 对端地址识别客户端。下方的代理警告说明了此设置所产生的日志行。 |

- **登录节流。** `/auth/login` 与浏览器批准中的密码校验，按三个维度计数失败：（用户名, 来源地址）、来源地址，以及跨地址的账号。IPv6 地址在每个维度中都按其 /64 前缀计数。被节流的请求会返回 `429 Too Many Requests` 和以秒为单位的 `Retry-After` 响应头。被拒绝的请求不会校验密码，也不计入失败，因此继续猜测不会延长锁定。一次成功登录只清除（用户名, 来源地址）计数。所有探针都来自 `127.0.0.1`，因此探针既计入（用户名, 来源地址）这一维度，也计入来源地址这一维度；参见 [重新运行探针](#重新运行探针)。在 `LOGIN_RECENT_SUCCESS_SECONDS` 内曾成功登录该账号的来源，不受该账号的锁定影响，但其自身的计数仍然生效。探针不测试这一豁免。
- **跨会话的批准。** 浏览器批准与 `/auth/login` 计入同一个（用户名, 来源地址）计数。通过 `StartAuthSession` 开始新的浏览器会话不会重置该计数，因此同一来源地址对同一用户名的新会话同样会被拒绝。单个会话内部仍适用每会话锁定（`AUTH_SESSION_MAX_ATTEMPTS`、`AUTH_SESSION_LOCK_SECONDS`）。
- **请求体限制。** `/auth/login`、`/auth/refresh` 和管理 API 的 JSON 请求体上限为 64 KiB，浏览器登录表单上限为 16 KiB。限制按实际收到的字节数计算，因此分块传输的请求体同样受限。超过上限的请求会收到 `413`。
- **已删除的用户。** 删除用户在认证服务中立即生效。该用户的访问令牌在 `/auth/me` 返回 `401`，刷新令牌在 `/auth/refresh` 返回 `401`，gRPC 令牌交换返回 `UNAUTHENTICATED`。
- **Lore Server。** Lore Server 会离线检查每个令牌的签名和有效期，密钥来自 `/.well-known/jwks.json`。对于身份令牌（即 `/auth/login` 返回的令牌），它随后会向认证服务询问该用户是否仍然存在且有权限，因此已删除用户的身份令牌会被 Lore Server 立即拒绝。仓库范围的令牌把授权信息放在 `resources` 声明中，Lore Server 无需调用认证服务即可直接评估。这类令牌会一直有效到过期，即使其用户已被删除，或该用户的仓库权限发生变化。实时测试和探针使用的都是身份令牌，因此本环境没有测试仓库范围令牌的情况。这里描述的时间窗口来自上游源码和认证服务 README，而不是本环境中的运行结果。
- **`TOKEN_TTL` 指引。** `TOKEN_TTL` 是被移除用户的仓库范围令牌在 Lore Server 上仍可使用的最长时间。默认的 10 天让已登录的客户端无需每天重新在浏览器中登录，因为 Lore Client 不刷新浏览器会话（`RefreshAuthSession` 返回 `UNIMPLEMENTED`）。对于敏感部署，请把 `TOKEN_TTL` 设为 `28800`（8 小时）或更短，这与认证服务 README 的建议一致。本环境保持默认值。
- **代理警告。** `TRUSTED_PROXY_COUNT` 为 `0` 时，服务会在每个进程中输出一次 `[proxy]` 警告，即首个来自私有、回环或其他非公网地址的请求到达时。本环境的客户端从 `127.0.0.1` 连接，因此每次启动后 `logs/auth.log` 中都会出现该警告：`[proxy] Requests arrive from a non-public address while TRUSTED_PROXY_COUNT=0. ...`。本环境没有反向代理，这一警告属于预期，不影响任何结果。请保持 `TRUSTED_PROXY_COUNT=0`。启动横幅会输出 `Proxies:     TRUSTED_PROXY_COUNT=0`。
- **升级已有环境。** 由 `setup-stack.sh` 创建的环境已经有生成的 `ADMIN_PASSWORD`，无需更改。如果已存储的管理员仍使用两个公开值之一（`changeme` 或 `replace-with-a-long-random-password`），本版本首次启动时会用 `ADMIN_PASSWORD` 替换该密码，并撤销该管理员的刷新令牌。`login_throttles` 与 `login_successes` 表会自动创建。升级前已登录过的来源，需要在升级后重新登录一次，才能免除账号级锁定。由提交 `f257d43` 写入的数据库，在首次启动本版本时会获得这两张表，并且探针在其上通过。

### 信任

Lore Client 的 TLS 使用 `rustls-native-certs`。设置了 `SSL_CERT_FILE` 时，它读取该文件而不是系统证书库。因此脚本会基于系统根证书加上本地 CA 生成 `tls/trust-bundle.pem`，并且只为 `loreserver` 进程和测试运行导出 `SSL_CERT_FILE`。不会把任何内容安装到系统信任库中。

## 测试用户

`seed-users.py` 通过管理 API 创建两个非管理员用户 `alice` 和 `bob`。他们的密码位于 `$LORE_E2E_HOME/auth/users.env`，管理员密码位于 `$LORE_E2E_HOME/auth/auth.env`。这两个文件的权限都是 600。

## 运行实时测试

```bash
scripts/e2e/run-live-tests.sh                    # 串行运行全部十个实时测试
scripts/e2e/run-live-tests.sh live_conflicting   # 按名称前缀运行一个测试
```

运行器会先检查 `rustc` 是否为 1.85 或更高版本，然后设置 `LORE_E2E_SERVER`、`$LORE_E2E_HOME/work/` 下的临时目录、`LORE_E2E_SHIM_DIR` 和 `SSL_CERT_FILE`，然后执行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib live_ -- --ignored --test-threads=1 --nocapture
```

`--nocapture` 会保留每个测试输出的证据行（耗时、计数、文件路径）。务必串行运行：登录状态和 Lore 运行时都是进程级的。测试带有 `#[ignore]`，因此 `cargo test` 仍然保持离线。

### 浏览器登录

测试本身不驱动浏览器。当客户端通过 `xdg-open` 打开登录 URL 时，`$LORE_E2E_HOME/bin/xdg-open` 代替桌面浏览器。它从该 URL 读取 `session_code` 和 `client_state`，并以测试用户的身份批准会话，发送的请求与真人在登录表单中提交的相同。用户来自 `LORE_E2E_LOGIN_USER`（默认 `alice`），密码来自 `LORE_E2E_LOGIN_PASSWORD` 或 `users.env`。每次调用都会记录到 `$LORE_E2E_HOME/logs/xdg-open-shim.log`：先记录登录页路径，然后每次批准记录一行 `approve user=<用户名> http=<状态码>`，不包含会话码或密码。被节流的登录会记录为 `http=429`，参见 [故障排查](#故障排查)。

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

## 认证服务探针

`scripts/e2e/auth-service-probes.mjs` 通过认证服务的 HTTPS API 和 gRPC 端口，检查 [认证服务中的问题](#认证服务中的问题) 中列出的问题。它从 `setup-stack.sh` 安装的认证服务检出目录的 `node_modules` 中加载 gRPC 包。在 `start-stack.sh` 之后运行：

```bash
node scripts/e2e/auth-service-probes.mjs                 # 全部四组
node scripts/e2e/auth-service-probes.mjs login session   # 只运行指定的组
```

每项检查都会输出 `PASS` 或 `FAIL`，并附带状态码和计数。只要有任何检查失败，脚本就以退出码 1 结束。它会创建 `probe-*` 用户，每次运行使用新的后缀，运行结束时删除这些用户，并且从不输出密码、令牌或会话码。

| 分组 | 检查项 | 修复后的预期结果 |
| --- | --- | --- |
| `login` | 错误密码会被节流 | 30 次尝试中出现若干 `429`，且没有 `200` |
| `login` | 节流期间正确密码被拒绝 | `429` |
| `login` | 被节流的响应带有 `Retry-After` | 一个正的秒数 |
| `body` | 任何传输编码下的超大 JSON 都以 413 拒绝 | 对 200 KiB 请求体，无论使用 Content-Length 还是分块传输、密码正确与否，都返回 `413` |
| `deleted` | 删除前可以登录 | 登录 `200`，`/auth/me` `200`，gRPC 代码 `0` |
| `deleted` | 删除后访问令牌被拒绝 | `/auth/me` `401` |
| `deleted` | 删除后 gRPC 拒绝访问令牌 | gRPC 代码 `16`（UNAUTHENTICATED） |
| `deleted` | 删除后刷新令牌被拒绝 | `/auth/refresh` `401` |
| `session` | 错误猜测会锁定会话 | 四次 `401:invalid`，然后 `429:locked` |
| `session` | 会话锁定后正确密码被拒绝 | `429:locked` |
| `session` | 新会话共享该锁定 | 十个新会话均为 `429:locked` |
| `session` | 锁定期间，新会话中的正确密码被拒绝 | `429:locked` |

在 `f3742a7` 上的运行输出（全新的认证数据库）：

```text
login: 30 consecutive wrong passwords -> 401 x5, 429 x25
login: correct password after 30 failures -> HTTP 429
PASS login: wrong passwords are throttled: 401 x5, 429 x25
PASS login: correct password is refused while throttled: HTTP 429
PASS login: throttled response carries Retry-After: Retry-After 60
body: 200 KiB JSON, Content-Length, wrong password -> 413
body: 200 KiB JSON, Content-Length, right password -> 413
body: 200 KiB JSON, chunked, wrong password -> 413
body: 200 KiB JSON, chunked, right password -> 413
PASS body: oversized JSON is refused with 413 for every transfer encoding: 413 413 413 413
deleted: login -> HTTP 200; /auth/me before delete -> HTTP 200; gRPC exchange before delete -> code 0
PASS deleted: sign-in works before deletion: login 200, /auth/me 200, gRPC code 0
deleted: DELETE /admin/users/probe-deleted-c413b389 -> HTTP 200
deleted: /auth/me with the access token after delete -> HTTP 401
PASS deleted: access token is refused after deletion: HTTP 401
deleted: gRPC exchange of the access token after delete -> code 16
PASS deleted: access token is refused by gRPC after deletion: gRPC code 16
deleted: /auth/refresh with the refresh token after delete -> HTTP 401
PASS deleted: refresh token is refused after deletion: HTTP 401
session: one session, 5 wrong guesses then one more -> 401:invalid 401:invalid 401:invalid 401:invalid 429:locked 429:locked
session: correct password in the same session after the lock -> 429:locked
session: 10 new sessions via unauthenticated StartAuthSession, one wrong guess each -> 429:locked x10
session: new session with the correct password -> 429:locked
PASS session: wrong guesses lock the session: 401:invalid 401:invalid 401:invalid 401:invalid 429:locked 429:locked
PASS session: correct password is refused after the session lock: 429:locked
PASS session: new sessions share the lock: 429:locked x10
PASS session: correct password in a new session is refused while locked: 429:locked
12 of 12 checks passed
```

对修复前的提交（`LORE_AUTH_SERVICE_REF=f257d43 scripts/e2e/setup-stack.sh`，然后 `start-stack.sh`），同一脚本输出 `5 of 12 checks passed`。失败的七项检查是三个登录检查、请求体检查、`deleted: access token is refused after deletion`，以及两个新会话检查。修复前的服务还会对新会话中的正确密码返回 `200`。

### 重新运行探针

每次运行都会使用新的 `probe-*` 用户，并在结束时删除它们，因此用户名维度的计数不会从上一次运行带到下一次。但每次运行仍会从 `127.0.0.1` 记录十次失败的登录：五次来自 `/auth/login`，五次来自浏览器批准。被实时测试中的错误密码用例再记录一次。这些失败计入来源地址计数（`LOGIN_MAX_FAILURES_PER_IP`，默认 100），新用户不会重置该计数。计数器在一小时内没有新的失败后重新开始；若 `LOGIN_LOCK_MAX_SECONDS` 更长，则以它为准。

在默认设置的全新数据库上测得：连续十次运行各自通过 12 项检查，第十次运行结束时地址计数达到 100。第十一和第十二次运行在管理员登录这一步即被拒绝，输出 `FAIL admin sign-in: admin login failed with HTTP 429` 并以退出码 1 结束。若在 60 秒的锁定过期之后、计数仍为 100 时开始一次运行，它的第一次错误猜测会得到 `401`，其余请求被拒绝，并且这次失败把锁定时长提高到 120 秒。该次运行报告 `10 of 12 checks passed`，其中部分检查是因错误的原因而通过的，例如每次会话猜测都返回 `429:locked`。请阅读 `FAIL` 行，而不要只看计数。

如需再次运行探针，请二选一：

- 停止环境，然后在关闭按地址计数的维度的情况下启动：先运行 `scripts/e2e/stop-stack.sh`，再运行 `LOGIN_MAX_FAILURES_PER_IP=0 scripts/e2e/start-stack.sh`。这只关闭该维度；（用户名, 来源地址）维度和账号维度仍然生效。实测：切换后连续十次运行均通过 12 项检查，地址计数保持在 101。
- 停止环境，删除 `auth/lore-auth.db*`（这同时会清除计数，以及 `alice` 和 `bob` 用户，`start-stack.sh` 会重新创建它们），然后再次启动环境。实测：在新数据库上的一次运行通过 12 项检查。

`start-stack.sh` 会保留仍在运行的服务，因此只有先停止环境，覆盖的环境变量才会生效。

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

`bun run test:ui` 运行完整的 `scripts/cdp-smoke.mjs` 冒烟检查，只覆盖前端行为，不包含 Tauri 后端。脚本驱动无头 Chrome，显式使用简体中文，不依赖宿主区域设置。

```bash
bun run test:ui
bun run test:ui:core
```

核心套件与完整套件共享启动与历史首屏、修订单击/双击、命令与设置、懒加载失败恢复这四个工作流。核心套件为每个工作流创建新文档并清空测试资料中的偏好，避免依赖前序步骤；Linux CI 运行此套件并上传摘要、日志与失败截图。完整套件继续覆盖全部交互和视觉断言。

脚本默认使用端口 1420：已有 Vite 服务会被复用，否则自动启动并在结束时关闭。设置 `LORE_CDP_PORT` 可为独立检出或并行运行选择另一端口；脚本不会关闭被复用的服务。每次运行使用独立的临时浏览器资料，结束后清理。

设置 `LORE_CLIENT_BROWSER_PATH` 可指定 Chrome 或 Chromium；未指定时自动发现系统浏览器。设置 `LORE_CDP_ARTIFACT_DIR` 后，成功和失败都会写入 `summary.json`；交互失败时尽力保存 `failure.png`，预期的懒加载失败场景保存为 `cdp-lazy-view-failure.png`。`LORE_CDP_SCREENSHOT_DIR` 可单独指定截图目录。浏览器启动失败也会返回非零退出码并写入失败摘要。

## `LORE_E2E_HOME` 的目录结构

```text
bin/loreserver           解出的服务器二进制
bin/xdg-open             登录批准垫片
auth/auth.env            认证服务设置，包括 ADMIN_PASSWORD（0600）
auth/users.env           测试用户凭据（0600）
auth/keys/               认证服务生成的 RS256 签名密钥（private.pem 为 0600）
auth/lore-auth.db        认证服务的 SQLite 数据库（用户、权限、会话、登录计数）
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
- `auth-service-probes.mjs` 和垫片只记录状态码和计数，绝不记录密码、令牌或会话码。

## 认证服务中的问题

以下问题都是在本环境中复现的，修复于 lore-auth-service PR #1。修复位于 PR 分支的 `f3742a7`。`auth-service-probes.mjs` 会在运行中的服务上检查第 1 至 4 项，认证仓库的测试（`test/config.test.ts`）覆盖第 5 项。第 6 项位于镜像中，不属于 lore-auth-service，仍未修复。

1. **登录尝试次数限制（已修复）。** `/auth/login` 没有限制：连续三十次错误密码都返回 401，随后正确密码返回 200。现在，同一用户名从同一地址（IPv6 按 /64 前缀）连续五次密码失败后，该组合会被锁定 60 秒，每次额外失败后锁定时长翻倍，上限为 900 秒。被节流的请求返回 `429` 和 `Retry-After`。
2. **跨会话的批准锁定（已修复）。** `AUTH_SESSION_MAX_ATTEMPTS` 次失败批准后的锁定只作用于单个浏览器会话。gRPC 端口上的 `StartAuthSession` 不需要任何凭据，因此每个新会话都从未锁定状态开始：十个新会话中的十次错误密码都被以无效凭据拒绝，随后在新会话中输入正确密码即被接受。现在，批准与 `/auth/login` 计入同一个（用户名, 来源地址）节流计数，因此同一地址对同一用户名的新会话会收到 `429`。
3. **分块请求的请求体限制（已修复）。** 64 KiB 限制只在请求声明了 `Content-Length` 时生效。声明了长度的超大请求即使密码正确也会收到 `400 Missing username or password`；同样大小的分块请求则以正确密码通过验证，返回 `200`。现在限制按实际收到的字节计算，两种传输方式都收到 `413`。
4. **已删除用户的访问令牌在 `/auth/me` 上（已修复）。** 已删除用户的访问令牌在过期前一直让 `/auth/me` 返回 200，而 `/auth/refresh` 早已拒绝其刷新令牌。现在 `/auth/me` 也会拒绝该访问令牌；gRPC 令牌交换原本就会拒绝它。删除前签发的令牌在 Lore Server 上的行为，参见 [认证服务设置](#认证服务设置)。
5. **默认管理员密码（已修复）。** `ADMIN_PASSWORD` 默认为 `changeme`，服务只在启动时输出一条 `[security]` 警告。现在，除非 `ADMIN_PASSWORD` 设为至少 8 个字符且不是 `changeme` 或示例占位符的密码，否则拒绝启动；只有设置 `ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD=true` 时例外。探针不检查此项，因为启动被拒绝在运行中的服务上是不可见的。
6. **镜像标签（未修复）。** `lore-server:0.10.1` 镜像的 `title`、`description` 和 `url` 标签指向认证服务，而 `source` 标签指向 `EpicGames/lore`（参见“运行的组件”）。

## 故障排查

- `lore-auth-service did not answer` 或 `loreserver did not open`：阅读 `logs/auth.log` 或 `logs/server.log`。端口可能已被占用，可用 `netstat -ltnup` 检查。
- 客户端或认证服务报证书错误：确认 `tls/trust-bundle.pem` 以 E2E CA 结尾，并且 `tls/server.pem` 与 `LORE_E2E_HOST` 匹配。
- 登录挂起并超时：阅读 `logs/xdg-open-shim.log`。没有记录说明客户端没有调用垫片，这通常是因为 `LORE_E2E_SHIM_DIR` 不在 `PATH` 的最前面。`run-live-tests.sh` 会为你设置它。
- `start-stack.sh` 报 `admin login failed`：`auth/auth.env` 中的管理员密码与数据库不匹配。当数据库是用另一个密码创建时会出现这种情况。恢复旧值，或删除 `auth/lore-auth.db` 重新开始。
- `logs/auth.log` 中出现 `ADMIN_PASSWORD must ...`：`auth/auth.env` 中没有可用的管理员密码（缺失、少于 8 个字符，或为公开值）。删除 `ADMIN_PASSWORD` 那一行，然后重新运行 `setup-stack.sh`，它会生成新的密码。如果数据库中的管理员使用的是另一个非公开密码，`start-stack.sh` 随后会报 `admin login failed`，见上文。
- `logs/xdg-open-shim.log` 中出现 `http=429`，或探针报告管理员登录返回 `HTTP 429`：该来源地址处于登录锁定中。参见 [重新运行探针](#重新运行探针)。
- `logs/auth.log` 中出现 `[proxy] Requests arrive from a non-public address`：在本环境中属于预期，因为没有反向代理，客户端从 `127.0.0.1` 连接。请保持 `TRUSTED_PROXY_COUNT=0`。若服务前面确实有代理，请改为把 `TRUSTED_PROXY_COUNT` 设为代理层数；参见 [认证服务设置](#认证服务设置)。
