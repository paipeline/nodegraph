# Nodegraph

给 AI 写代码用的「存档 / 读档」。你跟 agent 磨出来的理解是最贵的东西;nodegraph 让你能从任意一个理解点分叉出去试第二、第三种做法,试废了整条丢掉,主线一尘不染。

## Language

**Node**:
一次存档。由两半组成:一份继承自父节点的 Context,和一块与其他 Node 隔离的 Workspace。图上的一个点就是一个 Node。
_Avoid_: Task, Lane, Card, Ticket, Job, Branch

**Fork**:
从一个 Node 分出新 Node 的动作。新 Node 继承父节点的全部理解,拥有自己独立的代码现场,此后两条互不影响。
_Avoid_: Split, Spawn, Copy, Branch out

**Context**:
一个 Node 里 agent 的记忆——它读过什么、想通了什么、跟你商定了什么。Fork 时被完整继承,这是 Fork 唯一的意义。
_Avoid_: History, Transcript, Memory, Conversation

**Workspace**:
一个 Node 独占的代码现场。Fork 时随 Node 一起产生,Node 被 Discard 时随之消失。
_Avoid_: Worktree, Directory, Sandbox, Repo, Checkout

**Trunk**:
你不允许任何一次试验弄脏的那条线。所有 Node 最终的祖先。
_Avoid_: Main, Master, Base

**Discard**:
把一个 Node 连同它的 Workspace 和被污染的 Context 一起丢掉,不留痕迹。**敢 Discard 是这个产品一半的价值**——不敢丢的存档等于没有存档。
_Avoid_: Delete, Archive, Close, Abandon
