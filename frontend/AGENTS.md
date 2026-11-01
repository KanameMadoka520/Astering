# 前端 agent 必读

修改本目录前，必须先阅读并遵守：

- [根目录 AGENTS.md](../AGENTS.md)
- [长期开发准则](../.agents/docs/development-principles.md)
- [API 与共享查询层](../.agents/docs/api.md)、[测试](../.agents/docs/testing.md)、[代码风格](../.agents/docs/code-style.md)及[中英文翻译](../.agents/docs/translations.md)
- 涉及资源请求、图片、缓存或 Service Worker 时的[缓存约定](../docs/browser-cache.md)

优先复用生成 SDK、查询模块和现有组件。特别核对异步操作的目标与认证会话、草稿保护、HTTP/SSE 竞态、删除后仍挂载的编辑器，以及局部更新时的滚动和焦点。不要用整页刷新或新增重复状态仓库修补问题。

可见交互按影响范围用真实浏览器验收，检查桌面与小屏、中英文、键盘、错误恢复及外链行为；运行对应 lint、强制 typecheck 和必要的回归测试。缓存命中测试不能启用会禁用缓存的请求拦截。仅修改文档不需要运行应用测试或登录生产环境。
