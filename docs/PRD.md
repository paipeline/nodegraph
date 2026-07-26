# PRD: nodegraph v1 — Fork / Discard

> 术语一律以 [CONTEXT.md](../CONTEXT.md) 为准:**Node / Fork / Context / Workspace / Trunk / Discard**。
> 节点身份的依据见 [ADR-0001](adr/0001-node-is-a-fork.md)。

## Problem Statement

我跟 coding agent 磨了 40 分钟,它终于读懂了我的项目、跟我把方案定下来了。这段 **Context 是我手上最贵的东西**——它不在代码里,不在 git 里,只活在那一个会话里。

然后我要做一个选择,而我**不敢试**:

- 让它就地开写 → 一旦写下去,这段 Context 就被这次尝试染色了。我再想换一种做法,它会带着上一次的偏见,而且两次尝试的代码搅在同一个工作区里,我没法并排比较。
- 另开一个会话 → 那 40 分钟从零再来一遍。

所以我总是**只试第一种做法**,并且在心里知道它可能不是最好的那一种。更糟的是,试坏了之后我不敢清理:分支、worktree、半截的改动堆在那里,几周后我已经分不清哪条是活的、哪条是死的。

打游戏我不会这样——打 boss 前先存档,死了读档换个打法。**写代码时我没有存档。**

## Solution

nodegraph 是给 AI 写代码用的**存档 / 读档**。

图上一个 **Node** 就是一个存档点,它由两半组成:**Context**(agent 的全部记忆,原样继承)和 **Workspace**(独占的代码现场)。

核心循环三步:

1. 在任意一个 Node 上按 **Fork** → 长出一个子 Node,继承父节点的全部理解,拥有自己的地盘;
2. 让它跑。可以同时 Fork 出三条,三个 agent 并行跑三种做法,**互相不知道对方存在**;
3. 成了就留下,废了就 **Discard**——Workspace、分支、那段被污染的 Context 一起消失,**Trunk 一尘不染**。

左边是 ReactFlow 画的图:我一眼看见自己从哪里存的档、试了几条路、哪条还活着、哪条在等我说话。右边是选中 Node 的**真 TUI**,我直接在里面打字。

图存在的唯一理由:三个存档点是列表,三十个存档点必须是图。

## User Stories

### 看见(Graph)

1. As a developer, I want 打开 nodegraph 时看到当前 repo 的整张 Node 图, so that 我不用翻五个终端 tab 去回忆自己在干嘛。
2. As a developer, I want 图的根节点是 Trunk, so that 我永远知道哪条线是不能弄脏的。
3. As a developer, I want 每条边表示 Context 的继承关系(谁 Fork 自谁), so that 我看得出哪几条路来自同一段理解。
4. As a developer, I want 节点按状态用颜色区分(跑着 / 等我 / 闲着 / 环境准备中 / 已死), so that 我扫一眼就知道该看哪个。
5. As a developer, I want 在等我输入的 Node 明显闪烁或高亮, so that 我不会让一个 agent 干等好几天。
6. As a developer, I want 图自动布局,同时允许我拖动节点并记住位置, so that 我能靠空间记忆找到东西,而不是每次重新读标签。
7. As a developer, I want 每个 Node 上显示一句话标题(取自开启它的那句 prompt,可手工改), so that 二十个节点我也认得出谁是谁。
8. As a developer, I want 每个 Node 显示它的分支名和 Workspace 路径, so that 我随时能自己开终端进去。
9. As a developer, I want 节点上显示"距上次活动多久", so that 我认得出僵尸。
10. As a developer, I want 关掉 app 再打开,图还在, so that 这个东西能承载跨天的工作。
11. As a developer, I want 在多个 repo 之间切换视图, so that 我一台机器上所有项目都能用它。

### 分叉(Fork)

12. As a developer, I want 在任意 Node 上按一下就 Fork 出一个子 Node, so that 我敢于尝试第二种做法。
13. As a developer, I want 子 Node 完整继承父 Node 的 Context, so that 那 40 分钟的理解不用重建。
14. As a developer, I want Fork 的时候能顺便写一句"这条去试什么", so that 图上的每条路都有目的,而不是三个一模一样的节点。
15. As a developer, I want 一次 Fork 出多条(例如三条), so that 我能一口气铺开三种方案。
16. As a developer, I want 子 Node 拿到的是父 Node **此刻**的代码现场,包括还没提交的改动, so that "从这里分出去"符合我脑子里的意思。
17. As a developer, I want Fork 按下去立刻返回、agent 立刻开工, so that 这个动作感觉像存档而不是像装环境。
18. As a developer, I want 重环境(node_modules / target / .venv)在后台克隆并显示"环境准备中", so that 我不用为了等一个复制发呆。
19. As a developer, I want gitignored 的小文件(如 .env)被自动带过去, so that 新 Workspace 一开始就是跑得起来的。
20. As a developer, I want 在项目里放一个 on_fork 钩子来覆盖默认的环境处理, so that 我的怪项目也能用。
21. As a developer, I want Fork 过程中任何一步失败都能干净回滚, so that 我不会得到一个半死不活的节点和一堆垃圾分支。
22. As a developer, I want 只在 agent 停下来的时候才能 Fork, so that 我不会复制到一个跑了一半的、精神分裂的 Context。
23. As a developer, I want 从一个已经 Discard 掉的 Node 的父节点重新 Fork, so that 我能"读档重来"。

### 干活(Session)

24. As a developer, I want 点一个 Node 右边就出现它的真 claude TUI, so that 权限弹窗、斜杠命令、Ctrl-C 全都照常能用。
25. As a developer, I want 直接在右边打字回复那个 agent, so that 处理一个 blocked 的节点只要五秒。
26. As a developer, I want 在节点之间切来切去而不打断任何一个 agent, so that 三条路可以真正并行。
27. As a developer, I want 关掉浏览器再打开,agent 还在跑、TUI 还能接回去, so that 我的进程不依赖一个网页开着。
28. As a developer, I want 看到每个 Node 的 agent 是在跑、在等我、还是已经退出, so that 我知道下一步该管谁。
29. As a developer, I want 在 Node 上手动停掉 / 重启 agent, so that 卡死的时候我有救。

### 比较(Diff)

30. As a developer, I want 看到一个 Node **相对它的分叉点**改了什么, so that 我看到的是"这条路干了什么",而不是掺着父节点历史的一锅粥。
31. As a developer, I want 即使父节点后来又往前走了,这个 diff 依然稳定, so that 比较结果不会莫名其妙地变。
32. As a developer, I want 并排看两三个兄弟 Node 的 diff, so that 我能真正做出选择。
33. As a developer, I want 看到每个 Node 改了哪些文件、多少行, so that 我不用点进去就有大致判断。

### 丢弃(Discard)

34. As a developer, I want 一键 Discard 一个 Node,连它的 Workspace 和分支一起清掉, so that 我敢做实验。
35. As a developer, I want Discard 前如果有未提交的改动会拦我一下, so that 我不会误删真的想要的东西。
36. As a developer, I want Discard 一个还有子节点的 Node 时被明确警告, so that 我不会连带砍掉还活着的路。
37. As a developer, I want Discard 掉的节点在图上留一个可选显示的墓碑, so that 我记得这条路试过、失败了,不会再试一遍。
38. As a developer, I want Trunk 永远不可 Discard, so that 这个工具不可能毁掉我的主线。
39. As a developer, I want 批量 Discard 所有很久没动的死节点, so that 图能定期清干净。

### 现实校准(Reconcile)

40. As a developer, I want 我在终端里手动删掉一个 worktree 之后,图上对应的节点也随之消失或标记为已失效, so that 这张图永远不说谎。
41. As a developer, I want 别的工具(codex / vibe-kanban / 我自己)建出来的 worktree 也出现在图上,标为"来历不明", so that 图反映的是完整现实而不只是我从这里点出来的东西。
42. As a developer, I want 把一个"来历不明"的节点手工挂到某个父节点下, so that 我能把现实收编进这张图。
43. As a developer, I want 猜出来的边和确认过的边在视觉上不一样(虚线 / 实线), so that 我不会把工具的猜测当成事实。

### 上手

44. As a developer, I want 一句 `npx nodegraph` 就能在当前 repo 里跑起来, so that 我不用装任何东西就能试。
45. As a developer, I want 第一次打开时,即使我一个 Node 都还没建,也能看懂该做什么, so that 我不会开了就关。

## Implementation Decisions

### 产品形态

- **本地 server + 浏览器**,`npx nodegraph` 在当前 repo 启动。前端 React + ReactFlow,后端 Node。不做 Electron / Tauri 打包(v1 之后再考虑)。理由:开源传播里安装摩擦为零最重要,且 pty 与文件系统必须在本机。

### 数据归属(Source of truth)

- **世界是存在性的真相,应用只拥有世界表达不了的东西。**
  - 由 `git worktree list`、`claude agents --json`、Claude Code transcript 投影出来的:Node 是否存在、agent 状态、分支、cwd、活动时间。
  - 由 NodeStore 自己拥有的:**Fork 边(谁继承了谁的 Context)**、分叉点 commit、父 session id、标题与备注、画布坐标、Discard 墓碑。
- 理由:Fork 的意图无法从 git 事后考古出来(实测 88 个 repo / 189 条分支,merge-base 无法区分"从 A 分出来"与"和 A 从同一个 commit 分出来"),所以必须在**发生的那一刻**记下来;而节点的存活与否必须以世界为准,否则图会说谎,图一旦说谎产品就死了。

### Fork 的语义

一次 Fork 是一个**事务**,任一步失败整体回滚:

1. **ContextForker**:以父 Node 的 session 为源复刻出一个新 session(`--resume` + `--fork-session` + 指定新 session id),父子此后互不影响。
2. **WorkspaceProvisioner**:
   - 从父 Node 当前 HEAD 建立新 Workspace 与新分支;
   - 把父 Node **未提交的改动**一并搬过去(Fork 的语义是"从此刻",不是"从上次 commit");
   - 记录**分叉点 commit SHA**(供 DiffService 使用,使 diff 在父节点前进后依然稳定);
   - 环境:gitignored 的小文件同步复制;`node_modules` / `target` / `.venv` / `.next` 等重目录用 **APFS 写时复制异步克隆**(实测 830M 克隆耗时 22 秒、实际占盘 38MB),Fork 立即返回,节点显示"环境准备中";
   - 项目可提供 `on_fork` 钩子覆盖以上默认行为。
3. **NodeStore**:落库 Node、Fork 边、分叉点、父 session id。

**Fork 只允许在 agent 处于停止/等待状态时发起**,不允许在它跑到一半时复制 Context。

### 会话呈现

- **真 pty**(node-pty + xterm.js),跑真正的 claude TUI,保真度 100%,权限弹窗与斜杠命令原样可用。
- pty 进程的生命周期与浏览器解耦:关掉页面 agent 继续跑,重开页面能接回缓冲区。
- 节点状态综合三个来源判定:pty 存活、`claude agents --json` 的 state、transcript 最后活动时间。

### 校准

- v1 用**轮询**投影世界(worktree 列表、活动 session、transcript 时间戳)。Claude Code 的 hook(`WorktreeCreate` / `PostToolUse` 等)可以做到即时,但那是 v1.1。
- 投影出来但 NodeStore 里没有 Fork 边的 Workspace,进图时标为**来历不明**,边用虚线,允许人工确认或改挂。**工具猜出来的关系永远不画成实线。**

### Discard

- 删除 Workspace 与其分支,写入墓碑(保留标题、分叉点、失败原因备注)。
- 有未提交改动、或存在子 Node 时必须二次确认。
- Trunk 不可 Discard。

### Diff

- 一律以 **Fork 时记录的分叉点 SHA** 为基准计算,不用运行时 merge-base,以免父节点前进后 diff 漂移。

### 模块划分

`WorkspaceProvisioner`(建毁工作区与环境)、`ContextForker`(复刻会话)、`ForkEngine`(事务编排)、`Reconciler`(世界快照 → 节点状态,纯函数)、`SessionSupervisor`(pty 生命周期与状态)、`DiffService`、`DiscardService`、`NodeStore`、`GraphView`。

## Testing Decisions

**什么是好测试**:只测外部可观察行为——给定一个真实的临时 git 仓库和一份世界快照,调用模块的公开接口,断言磁盘状态、返回值和状态迁移。不断言内部调用顺序,不 mock 被测模块自己的内部结构。测试要在没有网络、没有真实 Anthropic 账号的情况下能跑。

**要写测试的模块**(四个,均为深模块):

1. **WorkspaceProvisioner** — 在临时 git 仓库上跑。覆盖:从干净父节点建 Workspace;父节点有未提交改动时改动被搬运;gitignored 小文件被复制;重目录克隆是异步的且完成前节点可用;`on_fork` 钩子覆盖默认行为;中途失败时不留垃圾分支或半截目录。
2. **Reconciler** — 纯函数,注入伪造的世界快照 + NodeStore 状态。覆盖:worktree 消失 → 节点标记失效;出现未知 worktree → 标记来历不明;agent 从 running 变 blocked;墓碑不因世界里已无对应物而复活。
3. **DiscardService** — 覆盖:正常删除后 worktree 与分支都不存在;有未提交改动时拒绝并报告;有子 Node 时拒绝并报告;Trunk 拒绝;删除后墓碑存在。
4. **DiffService** — 覆盖:相对分叉点计算;父节点前进后结果不变;子节点有未提交改动时计入;二进制/删除/重命名文件不炸。

**测试替身**:`ContextForker` 与 `SessionSupervisor` 的测试通过在 PATH 上放一个假的 `claude` 可执行文件来驱动,验证参数拼装(resume / fork-session / session-id)与进程生命周期,不调用真模型。

**Prior art**:本仓库为全新项目,尚无既有测试。这四个模块的测试将成为约定的样板——每个测试自建临时 git fixture,测试之间不共享状态。

## Out of Scope

- **团队协作 / 多人共享一张图**(会把状态推上服务器,毁掉"本地零配置"这一卖点)。
- **容器 / devcontainer 隔离**(v1 用 APFS 克隆解决环境,不引入 Docker 依赖)。
- **stream-json 自渲染的 agent 界面**(v1 用真 pty;自渲染时间线是后续增强)。
- **把两条 Fork 的成果合并起来**(v1 只支持"留一条、丢其余";合并靠用户自己 cherry-pick)。
- **PR 的创建与管理**(PR 不是 Node,v1 连状态徽章都不做)。
- **Claude Code 以外的 agent**(codex / cursor / vibe-kanban 等,见下)。
- **基于 hook 的即时事件流**(v1 轮询)。
- **任务管理、todo、看板、进度汇报**。
- **Windows / Linux 的环境克隆优化**(APFS 是 macOS 特性;其他平台退化为 symlink 共享或直接复制)。

## Further Notes

**Fork 的时点语义已定案**,见 [ADR-0002](adr/0002-fork-captures-a-moment.md):Fork 复制父 Node 此刻的完整状态(含未提交改动),且只允许在 agent 停下来等待时发起。

**关于其他 agent**:在一台真实开发机上实测,189 条分支里 71 条来自 codex、26 条来自 vibe-kanban——**超过一半的分支不是 Claude Code 建的**。v1 只支持 Claude Code 是为了先把 Fork 的语义做对,但 Reconciler 从第一天起就要把这些外来 Workspace 投影成"来历不明"的节点,否则这张图对真实用户来说是残缺的。多 agent 的 Fork 支持是 v2 的头号候选。

**关于 demo 与传播**:v1 的验收标准就是那段视频——**一个节点分出三条,三个 agent 并行跑三种做法,十分钟后并排看三份 diff,留一个,删两个。** 任何不服务于这段视频的功能,v1 都不做。演示素材要用真实的、脏的仓库(节点数 20+),不要用干净的新项目;节点少于 5 个时这个产品看起来毫无意义。
