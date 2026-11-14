# 客户后端网站示例

Node.js 22.13+，使用内置 SQLite。先在 SDK 仓库根目录执行 `pnpm install && pnpm build`。
向 Tiana 登记三方应用名称及固定回调 `${CUSTOMER_ORIGIN}/tiana/callback`，取得应用凭据。

环境变量：

| 变量 | 内容 |
| --- | --- |
| CUSTOMER_ORIGIN | 浏览器访问本示例的 HTTPS Origin，例如 https://customer.example:9443 |
| CUSTOMER_PORT | 监听端口，默认 9443 |
| CUSTOMER_TLS_CERT / CUSTOMER_TLS_KEY | 本网站证书和私钥文件路径 |
| CUSTOMER_DATA_DIR | SQLite 会话目录，默认示例下 data/ |
| TIANA_ORIGIN | Tiana Console Origin |
| TIANA_CLIENT_ID / TIANA_CLIENT_SECRET | 登记应用后取得的 ID 与原始 secret |

将这些变量通过部署系统或本地私有环境文件注入，然后执行：

```sh
node examples/customer-backend/server.mjs
```

打开 `/workspaces/demo/databases?tab=sql#draft-17`，连接 Tiana，完成授权后核对完整路径，创建实例并执行 SQL。选择已有 Function 可调用它的 `/health` 或实际路由。

`server.mjs` 完整实现 `/tiana/start`、`/tiana/callback`、`/tiana/token`、`/tiana/logout`。后端持有 RT 与应用 secret；浏览器 `getCredential` 将自有接口返回映射为 SDK 凭据。实例和数据请求由浏览器直接发到 Tiana。

本示例单进程运行，用同一客户会话 ID 的互斥覆盖 callback、token、logout，并将 AT/RT/到期时间整体保存进 SQLite。部署多进程时，使用客户现有共享会话存储及其会话锁实现相同原子操作。已有客户登录系统可以直接复用自己的会话 ID，替换示例的 Cookie 与 sessions 表。

授权取消或新的连接失败时保留原连接；刷新结果未知时结束当前连接，重新登录。重复回调只返回保存的原页面，不重复兑换。退出清除当前 Tiana 凭据和待完成登录记录，三方应用自己的会话仍保留。
