# 后端 agent 必读

修改本目录前，必须先阅读并遵守：

- [根目录 AGENTS.md](../AGENTS.md)
- [长期开发准则](../.agents/docs/development-principles.md)
- [API 与生成客户端](../.agents/docs/api.md)、[测试](../.agents/docs/testing.md)及[代码风格](../.agents/docs/code-style.md)
- 修改模型、迁移或路由前，读取根目录指定的对应 `.agents/skills/<name>/SKILL.md`
- 涉及静态资源、私人文件、响应头或条件请求时的[缓存约定](../docs/browser-cache.md)

新接口使用 v2。权限由服务端落实，agent 工具同样受用户和资源权限约束；私人文件先鉴权再处理 304。保留出站 SSRF、文件访问、取消和流式协议语义，密钥及私人内容不得进入日志。

后台模型执行独立于浏览器页面生命周期；核对显式停止、断流恢复、末尾用量、连接池归属和释放。通过 Mage 执行所需检查，不并行运行会共享夹具的数据库测试；不得用生产数据做破坏性回归。仅修改文档无需构建、登录或部署。
