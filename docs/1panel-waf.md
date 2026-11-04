# Astering 的 1Panel WAF 维护

本站域名为 `task.tcymc.space`。1Panel 中的网站 ID 为 **7**；当前 WAF 攻击日志字典 `websites.db` 对应的 ID 为 **10**。两者属于不同数据源，查询日志前必须按域名重新解析字典 ID，不能直接把网站 ID 当作攻击日志 ID。

## 来源 IP 与限速

本站 nginx 配置引用 `sites/task.tcymc.space/security/cloudflare-realip.conf`，只信任官方 Cloudflare CIDR，并使用 `real_ip_header CF-Connecting-IP`。反向代理向应用覆盖写入 `X-Real-IP` 和 `X-Forwarded-For`，值为 nginx 处理后的 `$remote_addr`。不要向信任列表加入任意公网地址，也不要把客户端自报的转发头作为真实来源。

当 nginx 已完成上述校验时，WAF 应使用 nginx 的 `remote_addr`。当前已核验的 1Panel WAF 编译程序在**网站 `cdn.state=off`**时走 `get_ip_by_var`，优先读取 `ngx.var.remote_addr`；开启 `type=headers` 则会遍历常见转发头并优先返回其中的地址，不再受 nginx 的 Cloudflare 信任列表约束。不要把关闭这一网站的“CDN 头覆盖”误解为关闭网站 WAF。

该结论绑定于审计时的 1Panel v2.4.2、OpenResty 1.31.1.1 和实际安装的 WAF 编译程序；独立 WAF 引擎版本未公开确认。升级后应重新核查处理顺序及取 IP 逻辑。配置文档描述期望设置，不代表某次生产变更已经执行。

网站访问频率当前为 URL 模式、200 次／10 秒、封锁 600 秒。应用另有 WebSocket 握手及登录等入口的独立限制；当前握手默认是每来源 IP 每分钟 10 次，不受应用通用限速开关控制。前端 WebSocket 重连采用 1 秒起步、最高 30 秒的指数退避和 ±25% 随机抖动，明确认证失败后终止重连。保留这些防护；只有正常操作的可复现证据才能支持调整具体阈值。

HTTP 429 本身不能证明是 WAF 限速。排查时结合网站、时间、URL path、WAF 规则 ID／类别及现有日志中的上游状态。没有保留上游状态时应说明无法精确归因，不能据此全站放宽。源站访问日志中的请求也不能代表 Cloudflare 边缘独立拦截。

## 自定义兼容规则

本站原生 ACL 在以下位置：

```text
/opt/1panel/apps/openresty/openresty/1pwaf/data/sites/task.tcymc.space/rules/acl.json
```

`deploy/1panel-ai-steering-acl.json` 是已维护的 AI 兼容规则来源，边界见[运行中追加要求](arona-steering.md#1panel-站点兼容)。不要把它扩成整个 `/api` 或 `/api/v2` 前缀放行。

实际安装引擎的 ACL 条件全部匹配后才执行动作；`URL` 使用处理后的请求 URL，包含查询参数，`Header` 使用指定头名，`Method` 使用请求方法。`pattern: "regex"` 走引擎的正则匹配函数，不是 CEL 或任意 Lua 表达式。规则需要明确方法、完整路径边界，适用时再限制 Content-Type、UUID／数字 ID 和所需参数。

**`action: "allow"` 会直接结束后续 WAF 检查。** 当前链路的后续检查包含 URL、访问频率、方法、参数、JSON／上传内容与扩展名、Header、Cookie 等；不能把 allow 说成只跳过 SQL 或只跳过一个表单字段。Bearer 头格式只是匹配条件，不是真实认证。应用必须继续执行会话验证、资源所有权、只读用量显式授权、SSRF、凭据目的地、输入与二进制容量等限制。

优先在正常请求确实命中时排查具体规则，避免因为接口新增便预先放行。新建的 `/api/v2/system/usage/access`、`/api/v2/system/usage/users`，SSE 观察和 MCP 设置不默认新增例外。搜索／筛选、富文本 JSON 和图片上传分别验证；尤其不要用 multipart allow 顺带跳过原本需要保留的扩展名检查。没有核实当前引擎支持按参数或攻击类别排除时，不添加虚构的 `skip`、`exclude` 或 CEL 字段。

## 修改与验证

1. 修改前备份将要改变的本站文件，记录原字节 SHA-256、文件权限和当前规则。备份保存在仓库外的私有目录，禁止输出密钥或把完整生产配置提交到源码。
2. 默认只生成计划。应用时校验目标域名和原文件 SHA；存在并发修改则停止重新审阅。采用原子写入，仅改变已审查字段，执行 nginx 配置检查和温和重载，不重建 OpenResty、不改其他网站或全局规则。
3. 优先用固定无效令牌和合成请求，在本机直连应用与经过 WAF 的入口比较 JSON 401／403。覆盖 filter/search、JSON 描述、图片／附件、SSE、steering、MCP 与用量 GET。不得创建生产测试用户或使用用户正文作为测试载荷。此验证只证明请求到达认证拒绝边界，不证明授权业务、HTTP 缓存、完整 SSE 流或 Cloudflare 边缘行为。
4. 本机请求同样可能匹配 IP 白名单或改写来源 IP，因此还应只读确认该测试来源未被豁免。取 IP 修正完成后，不发送伪造 Cloudflare 头；确需验证信任边界时先在隔离环境检查。
5. 留存的结果仅包括方法、URL path、规则 ID／类别、状态、计数和检查结论，不保存 raw headers、查询值、请求／响应正文、真实令牌、邮箱或私人标题。
6. 回退前校验当前文件仍等于这次生成的版本，只恢复该文件的原字节并检查／重载。发现后来发生的合法变更时停止审阅，不覆盖它们。

官方参考：[网站设置](https://github.com/1Panel-dev/docs/blob/v2/docs/user_manual/xpack/waf/site.md)、[全局设置](https://github.com/1Panel-dev/docs/blob/v2/docs/user_manual/xpack/waf/global.md)、[白名单跳过后续检查](https://github.com/1Panel-dev/docs/blob/v2/docs/user_manual/xpack/waf/waf.md)、[nginx real-IP 信任语义](https://nginx.org/en/docs/http/ngx_http_realip_module.html)、[Cloudflare 来源 IP 头](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)及[官方 IP 段](https://api.cloudflare.com/client/v4/ips)。
