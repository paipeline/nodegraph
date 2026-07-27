# localhost 不是信任边界

nodegraph 只监听 127.0.0.1,但用户浏览器里的**任何一个页面**都能访问 127.0.0.1,而 `/session` 的另一端是用户仓库里一个真的 `claude`——能读走它打印的一切,也能往里打字。因此每一次 upgrade 和每一个会改变状态的请求都要过两道独立的门:一是本次运行时现生成的 key,只交给本服务器自己 serve 出去的那张页面(同源策略决定了别的站点拿不到它);二是 Origin 存在时必须等于本服务器自己的 origin。两道都要,是因为浏览器不会在 Origin 上撒谎,但非浏览器的攻击者干脆不发这个头;而只有 key 的话,key 一旦泄漏就再无第二层。

key 走 websocket 子协议和 `x-nodegraph-key` 请求头,不走 query string:URL 会进日志、进 Referer、进浏览器历史,而这三处都不是进程能收回的地方。任何人都不许打印它。

## Considered Options

- **只查 Origin**:被否。curl、任何脚本、任何非浏览器客户端不发这个头就绕过了——门卫只拦戴工牌的人等于没有门卫。
- **只发 key**:被否。key 泄漏的路径太多(粘进 issue、被页面里注入的脚本读走),没有第二层就直接失守;而且 Origin 检查是免费的。
- **key 放 query string**(`/session?key=…`):被否。实现最省事,但 URL 是最会到处乱跑的东西——服务器日志、Referer、历史记录,一旦落地就活得比进程久。
- **用 cookie 装 key**:被否。cookie 不区分端口,127.0.0.1 上任何一个别的本地服务都能读到、写到,等于把钥匙挂在整个 loopback 的公共门厅里。
- **拿 Host 头当"自己"的定义**:被否。DNS rebinding 场景下 Host 由攻击者控制(`Host: evil.example` 解析到 127.0.0.1),用它比对等于让攻击者自己签发通行证。改成用真实监听的端口拼出 origin。
- **给 /api 加 CORS 头让开发方便一点**:被否。这正是"悄悄侵蚀"的第一步——本项目一个 `Access-Control-Allow-Origin` 都不发。

## Consequences

- key 每次运行重新生成,所以昨天的 key 一文不值,页面也必须 `no-store`——缓存下来的页面带着过期的 key 反而会让用户以为坏了。
- 读操作(GET/HEAD)不要 key:挡住它们的是浏览器自己的同源策略(跨站读不到响应体),而给它们上锁只会把用户锁在自己的页面外面。
- `vite dev` 的 proxy 从此只能用来看图:vite 服务的页面是另一个 origin、手上没有 key,Fork 和挂 TUI 都会被拒。要改代码就 `pnpm build:web`,不要为了 proxy 好用去松这道门。
- 这类洞是回归性的:每加一个会改变状态的端点,都必须同时加一条"跨站打过来会被拒"的测试,否则下一个端点又是敞开的。
