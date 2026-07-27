# Context 由 nodegraph 自己复刻,代价是绑定 claude 的磁盘布局

Fork 时,nodegraph 亲手把父 Node 的 Context 文件复制到子 Node 的 Workspace 名下,取一个新的 session id;子 Node 此后只是在自己的 Workspace 里 `claude --resume <自己的 id>`。选这个是因为交给 claude 自己 fork 根本跑不起来:`--resume` 的查找**只在当前目录对应的那个 project 目录里进行**——在本机实测,换一个 cwd 去 resume 同一个 id,得到的是 `No conversation found with session ID: …`;回到那个 session 自己的 cwd 再来一次,就越过查找、停在了鉴权上。而子 Node 按定义就跑在一块独立的 Workspace 里,那是另一个目录,所以 `--resume <父 id> --fork-session` 永远找不到父亲的 Context。顺带解决的是 ADR-0002 欠下的另一半:自己动手,Context 就冻结在按下 Fork 的那一刻,而不是等到有人第一次打开子 Node 时才去读——后者会把 Fork 之后父 Node 说的每一句话都算进子 Node 的继承里。

claude 把每份 Context 放在 `$CLAUDE_CONFIG_DIR/projects/<Workspace 路径,把 / . _ 一律换成 ->/<session id>.jsonl`。这是观察出来的,不是文档写明的。

## Considered Options

- **第一次启动时 `--resume <父 id> --fork-session --session-id <子 id>`**:被否,而且是实测跑不通,不是嫌它不好——查找是按目录做的,子 Node 不在那个目录里。它还有第二个毛病:复刻发生在"第一次打开"而不是"Fork 那一刻",于是父 Node 在这中间说的话会全部漏给子 Node。旧实现建在这个调用上,测试全绿,但那些测试没有一个模拟过 claude 真实的 session 语义。
- **让子 Node 的 agent 跑在父 Node 的目录里,事后再搬**:被否。独占的代码现场就是 Node 的另一半(ADR-0001),为了让 resume 找得到而放弃它,等于把产品拆了一半去修另一半。
- **等一个官方支持的导出/导入**:被否。今天没有这个命令,而这一颗做完产品的核心论点才成立,不能等。
- **只继承代码,不继承 Context**:被否。ADR-0001 已经写死:继承理解是 Fork 唯一的意义。
- **连 session 的附属目录一起复制**(`<session id>/` 下的 subagent、工具输出等):被否。收益是边角料,代价是把耦合面从"一个文件"扩大到"一整棵目录树"。既然这个耦合注定要背,就把它压到最小:只复制那一份对话文件。
- **把 Fork 时写的那句话直接追加进子 Node 的 Context 文件**:被否。那样 nodegraph 就要伪造 claude 的记录格式(uuid、parentUuid、时间戳),耦合深得多;而且追加进去的话只会被当成历史读过,agent 不会真的去做——用户的指令会被静悄悄地忽略。它仍然作为 `claude` 的尾部 prompt 传进去,所以它是子 Node 真正被执行的第一条指令。

## Consequences

- nodegraph 从此依赖一个别人没有承诺过的磁盘布局。**它必须响亮地坏掉,不许悄悄地坏掉**:这个假设写成 `src/core/context.ts` 里的纯函数,由 `src/core/context.test.ts` 逐字钉死;一旦 nodegraph 自己放下去的 Context 不在该在的地方,Fork 直接拒绝,并把找过的那条路径原样说给用户看(`ContextNotWhereClaudeKeepsIt`)。改动了布局却没改测试,红的是测试;改了测试却没改布局,红的是 Fork。
- `CLAUDE_CONFIG_DIR` 跟 CLI 认的是同一个,所以 nodegraph 不可能找去 claude 不看的地方。测试全程指向自己的沙盒,决不碰使用者本机的对话。
- 复制过来的 Context 会被改写成"属于子 Node、发生在子 Node 的 Workspace 里"——只动 `sessionId` 和 `cwd` 两个字段,一个字的对话内容都不动;读不懂的行原样放行,因为丢掉一行读不懂的东西就是丢掉一份理解。
- **"写下来了"不等于"存在"**:agent 被打开却一句话都没说,claude 什么都不会落盘。所以 store 只负责说这个 Node 的 Context 叫什么名字,存不存在每次启动都去磁盘上问——否则那个 Node 会永远开不起来(`--resume` 一个不存在的 session 会立刻退出 1)。
- 一个没被打开过的 Node,它 Fork 时写的那句话还没被任何 agent 执行过,所以从它身上再 Fork 出去,拿到的是它继承来的那份理解,不含那句话。那句话仍然留在它自己身上,等着谁来打开它。
- claude 升级有可能挪走这个布局。那天到来时,先红的是 `src/core/context.test.ts` 和 `src/adapters/context.test.ts`,不是用户的图。
