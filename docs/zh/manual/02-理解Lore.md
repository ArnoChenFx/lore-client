# 理解 Lore

Lore 不是“把 Git 换一套名词”。它同样使用不可变历史和分支指针，但从一开始就围绕
大型二进制资产、按需获取和中心服务设计。先理解数据如何流动，再记界面名称，会更容易
判断一个按钮究竟会改变历史、指针、工作区还是只读视图。

## 一句话心智模型

Lore 是一个**以远端为规范状态、以内容片段保存数据、允许本地离线工作的二进制优先
版本控制系统**：

```text
文件内容 → 内容寻址的 Fragment → 完整文件树 → 不可变 Revision
                                                ↑
                               Branch Latest ───┘
```

本地工作区只物化当前任务需要的内容；Revision 中的其他内容仍然存在，需要时再读取。

## Revision：冻结的完整快照

Revision 是整个仓库文件树的不可变快照，不是“一组补丁”。普通 Revision 有一个父节点，
合并 Revision 有两个父节点，因此历史是有向无环图。

这带来几个重要结果：

- Revision ID 标识精确内容和父级关系；Revision 创建后不会原地改写。
- Inspector 可以先显示消息、作者和父级，再按需读取变更或完整文件树。
- Amend、拣选、撤销、恢复等操作如果改变历史内容，都会创建新的 Revision。
- 多个 Branch 可以指向同一个 Revision；Revision 不“属于”某一条分支。

界面里的 **工作区 HEAD** 表示当前 Instance 正在展示的精确 Revision。它与“当前选中的
Revision”和“某分支的 Latest”是三种状态，软件会分别显示。

## Branch：可以移动的 Latest 指针

Branch 是一个稳定身份与名称，核心作用是把 `Latest` 指向某个 Revision。创建 Branch
通常不复制文件，也不创建 Revision；它只是增加一个新的工作线指针。

因此：

- 单击 Branch 只选择它；双击或菜单中的 **切换/检出** 才会同步工作区。
- 本地和远端 Branch 可以暂时指向不同 Revision。
- **归档 Branch** 隐藏活动指针，但不会删除已存在的 Revision。
- **Reset Latest** 是移动指针的高风险操作，不是还原工作区文件。
- **保护 Branch** 用于阻止特定写操作；它与文件协作锁不是一回事。

## Tag：不会移动的仓库共享标记

Tag 把名称和说明附着到精确 Revision，并保存为仓库共享元数据。适合版本发布、里程碑、
审核结论和可读别名。

与 Branch 的区别：

- Branch 的 Latest 会随新 Revision 推进；
- Tag 指向精确 Revision，除非用户明确编辑或删除；
- Tag 不改变工作区，也不代表 Revision 的历史归属。

## Fragment：大文件局部传输和去重的基础

Lore 会把文件内容拆成内容寻址的 Fragment。相同 Fragment 只需保存一次，并可跨文件和
跨 Revision 复用。大型资产局部变化时，通常只需新增和传输受影响的片段。

这解释了几个常见现象：

- 同一个大文件在很多 Revision 中存在，不等于每版都完整复制一份。
- 打开文件某一部分时，Lore 可以只获取覆盖该范围的 Fragment。
- 离线时能否读取历史内容，取决于相关 Fragment 是否已在本地缓存。
- **验证 Fragment** 检查底层内容片段，不等于验证某个文件名。

## View：决定本机物化哪些路径

View 是当前 Instance 的入站物化规则。它控制 Clone、Sync、切换 Branch 和 Restore 时
哪些路径出现在本地磁盘，但不会从 Revision 中删除其他文件。

重要边界：

- View 是本机设置，不属于 Revision，也不会自动传播给其他成员。
- 修改 View 可能新增物化文件，也可能从本机撤除被排除的文件。
- View 与忽略规则不同：View 控制“历史内容是否写进本机工作区”；忽略规则控制
  “本地内容是否参与扫描、暂存和提交”。
- 应用 View 前必须先预览，而且工作区必须干净，避免撤除路径覆盖本地修改。

## 文件依赖：按任务范围获取内容

Lore 可以保存“源文件依赖目标文件”的显式有向边，并允许给边加标签。以一个或多个
根文件出发，软件可以查询依赖闭包，或者只同步/克隆根文件及选定依赖。

它不会分析文件内容来猜依赖。依赖边没有登记、标签不匹配或深度过小时，相关文件不会
自动进入选择范围。默认循环检测用于避免意外依赖环；**跳过循环检测**只适合明确知道
后果的场景。

## Link 与 Layer：两种完全不同的仓库组合

| 特性 | Link | Layer |
| --- | --- | --- |
| 保存位置 | 父仓库 Revision | 当前机器的 Instance 配置 |
| 是否随历史和 Clone 传播 | 是 | 否 |
| 是否固定精确来源 Revision | 是，通过 pin | 可按本地策略解析 |
| 典型用途 | 可复现的共享组件版本 | 私有工具、个人资产、CI 覆盖层 |

### Link

Link 把另一个仓库的精确 Revision 和子树挂载到父仓库路径。父 Revision 保存的是固定
pin，因此 Link 不会因为来源 Branch 前进而悄悄升级。修改 pin 会进入下一次父仓库
Revision。目标仓库仍有独立权限，无权限用户不能因为能读父仓库就读到 Link 内容。

### Layer

Layer 也把另一个仓库子树叠加到工作区，但它只存在本机，不进入父仓库历史。相同父
Revision 在不同机器上可以有不同 Layer。因此 Layer 很灵活，却不适合表达团队必须
一致复现的依赖。

## Shared Store 与 Instance

`Instance` 是一个独立本地工作目录，拥有自己的当前 Branch、工作树、View、暂存和身份。
多个 Instance 可以共享同一个 `Shared Store`，复用底层 Fragment 和缓存，但不会共享
未提交更改或选择状态。

适合场景：

- 同时打开两个 Branch 做对比；
- 每个自动化任务使用独立目录；
- 不同工具使用不同 View；
- 避免多个 Clone 重复保存相同大型资产。

删除一个 Instance 不等于删除 Shared Store 或其他 Instance。Shared Store 显示的容量
是当前唯一 Fragment 占用；在没有可靠基线时，软件不会虚构“节省了多少”。

## Clone、Sync 与 Push

### Clone

Clone 创建一个新的本地 Instance。它可以指定 Branch 或 Revision、View、Bare、
Shared Store、初始 Layer 和依赖闭包。Lore 默认按需获取，因此 Clone 完成不代表所有
历史二进制内容都已下载。

### Sync

Sync 获取远端 Branch 的新 Revision，并将远端进展并入本地工作线。并行修改可能产生
合并 Revision；内容冲突必须解决并创建收尾 Revision。

### Push

Push 先上传远端缺少的 Fragment，确认数据可用后再推进远端 Branch Latest。若远端
Latest 已被别人推进，最后一步会失败，但已上传的 Fragment 可以在后续 Push 中复用。

## 协作锁的真实边界

文件协作锁是**提示型锁**。它帮助团队表达“我正在编辑这个资产”，但不是存储层的绝对
写入禁令。软件只允许用当前身份释放自己的锁；不能识别所有者时，应先检查账户状态，
不要假定锁失效。

## 与 Git 直觉的快速对照

| 常见直觉 | Lore 中更准确的理解 |
| --- | --- |
| Clone 默认是完整副本 | Clone 是可稀疏、惰性水合的 Instance。 |
| Branch 包含一组专属提交 | Branch 只是共享 Revision DAG 上的可变 Latest 指针。 |
| 大文件另走 LFS | Fragment 分块、去重和范围读取是核心存储模型。 |
| sparse checkout 是附加模式 | View 与按需获取是常规工作方式。 |
| submodule 与工作树是附属机制 | Link 进入历史；Layer 留在本机；Shared Store 上的 Instance 彼此平等。 |

上述心智模型依据
[Epic Games Lore 官方文档](https://github.com/EpicGames/lore/tree/9664606f5a4708606642a6670a57d16bd3d37596/docs)；
Lore 仍处于 0.x，升级后应以当前应用支持的固定版本为准。

[上一章：快速入门](01-快速入门.md) · [下一章：工作区与导航](03-工作区与导航.md)
