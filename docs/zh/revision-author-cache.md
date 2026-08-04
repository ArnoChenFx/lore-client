# Revision 作者与分支创建者离线缓存

Lore Client 会把 Auth 服务已经确认的 Revision 作者和分支创建者
`userId → 显示名` 保存为本地脱敏缓存。缓存按稳定 Repository ID 与 userId 隔离，
因此移动仓库目录不会丢失映射，不同仓库也不会误用同名 userId。

## 用户可感知行为

- 在线读取仓库快照或历史时，Auth 返回的用户名覆盖旧缓存，并用于分支总览和
  Revision History。
- 仓库离线、Auth 暂时不可用或账户退出后，已解析过的作者继续显示缓存名称。
- 从未成功解析的 userId 继续原样显示；客户端不会用当前仓库 identity 猜测历史作者
  或分支创建者。
- Auth 只返回部分作者时，已缓存的其他作者不会被清空。

## 隐私与容量边界

缓存位于应用配置目录的独立 `revision-author-cache.json`，只包含 Repository ID、userId、
显示名和更新时间；普通界面偏好继续单独保存在 `client-preferences.json`。作者缓存不保存
Token、JWT、认证请求内容或头像 URL，最多保留 4096 条最新映射，并拒绝空值、超长字段和
控制字符。

## 运行期读写策略

Rust 适配层在进程首次访问作者缓存时惰性读取文件，之后的 Revision History 刷新直接
查询内存副本，不会重复读取或解析 JSON。只有 Auth 返回的新显示名与现有映射不同时，
客户端才会同步写回独立缓存文件；写入失败时不会提前替换内存状态。
