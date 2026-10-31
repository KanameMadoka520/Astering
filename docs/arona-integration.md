# 阿罗娜：模块边界与移植指南

阿罗娜是 vikunja-x 的原生任务助手。账号的 `persona` 设置为 `arona`（默认）或 `none`，后者保留名称但使用中性语气。下一条新消息读取最新设置，不重写历史消息或正在运行的请求。人设不参与权限计算。

## 功能目录与宿主适配

| 层 | 入口 | 责任 |
|---|---|---|
| 会话和执行内核 | `pkg/modules/tcyai/` | 持久会话、后台任务、流式协议、恢复、compact、fork、审核和预算 |
| 多模态附件 | `pkg/modules/tcyai/attachments.go` | 用户隔离、加密、去重、引用回收、四协议图片输入 |
| 可移植导出 | `pkg/modules/tcyai/exports.go` | Markdown、相对附件 ZIP、结构化 JSON |
| 人设 | `pkg/modules/tcyai/persona.go` | 只影响表达，不授予权限 |
| HTTP 适配 | `pkg/routes/api/v2/tcy_ai*.go` | 人类账号认证、配置与 Vikunja 执行器 |
| UI 功能目录 | `frontend/src/components/ai/` | 消息、审核（含看板分组影响预览）、偏好、调试、`timeline/`（执行时间线）、`RunStatus.vue`（用量口径）、`attachments/` 与 `export/` |
| 悬浮宿主 | `frontend/src/components/ai/FloatingArona.vue` | 延迟加载同一聊天组件、账户隔离、页面上下文和任务弹窗层级；收起不停止任务 |
| 页面装配 | `frontend/src/views/TcyAssistant.vue` | 路由上下文、输入、会话选择和站点布局 |
| 客户端适配 | `frontend/src/client/queries/{tcyAi,tcyConversations,conversationEvents,chatAttachments,assistantPreferences}.ts` | 生成客户端、账号上下文防护与缓存 |
| 产品工具适配 | `pkg/modules/tcyai/{tools,discovery}.go`、`pkg/routes/api/v2/tcy_ai_execution.go` | 工具目录、参数验证、逐次权限检查与实际变更 |

聊天组件可传入 `embedded`、`conversationId`、`contextProjectId`、`contextTaskId`，通过 `update:conversationId` 和 `activity` 事件与宿主通信；嵌入时不修改宿主 URL 或页面标题。成功写入后的刷新通过 `useRefreshAgentChanges` 对接宿主缓存。

移植时复制 `tcyai` 与 `components/ai` 功能目录，再替换宿主适配。这是边界明确的产品模块，**不是可以直接安装的独立 SDK**。

1. 宿主提供账号 ID、文件根目录、加密主密钥、语言和时间上下文；文件哈希不能作为授权凭证。
2. 替换 `Executor` / `Preparer` 和工具目录，把应用权限检查、预览与执行回执接入闭环，不直接执行模型给出的任意 SQL/URL/函数名。
3. 替换生成客户端和查询适配层。UI 依赖 Vue 3、TanStack Query、i18n、通用按钮/图标与上传中心；保留上传进度、取消和账号切换防护。
4. 替换站点路由、项目选择器和通知。运行附件隔离/去重/分支回收、四协议、多端导出及原有审核/恢复回归测试。
5. 遵守仓库 AGPL-3.0 许可证，保留相应声明。此模块不依赖 GitHub Actions。

## 执行时间线、用量口径与显示偏好

- 每轮模型请求的中间回复、服务商实际返回的思考、工具调用（参数摘要、状态、结果）、自动压缩与实验子任务都按轮次留在时间线里，下一轮不会覆盖上一轮；最终回答只在时间线下方出现一次。数据全部来自服务器保存的 `steps/actions/operations/auto_compactions/subagents`，离开重开、刷新、浮窗与完整页面看到的内容一致。纯推导规则在 `frontend/src/helpers/aronaTimeline.ts`。
- 用量分三种口径，互不混用（`frontend/src/helpers/aronaRunMetrics.ts`）：「本次/最后一次请求」只看一轮模型请求；「当前上下文」取后端 `context_status`（标明服务商报告或估算），旧记录退回最近一次已报告请求的输入，缓存命中的 token 仍占上下文；「本轮累计」以 `RunResult.usage` 为准，它已含联网搜索、自动压缩和子任务，前端只做分项说明，不重复相加，进行中的请求单列为临时值。容量为 0 时不计算百分比，未报告的数字显示为未知。
- 显示偏好（中间回复、服务商思考、工具详情的默认展开）只保存在本设备，按账户与 API 地址隔离（`arona-display:v1:*`），只影响呈现，不删除服务器上的任何记录。
- 聊天一次选择多张图片只询问一次原图/WebP（`chooseImageBatch` 的预设经仅客户端请求头传给上传传输层，发送前剥离），逐个上传，单个失败可重试且不再询问；附件也可从网盘选择（`from-drive`，只增加引用，不复制文件）。v32 起新上传的聊天附件与网盘共用同一份文件，存储端不再单独加密；此前的加密附件保持可读，会话记录本身仍加密保存。

## 存储与计量

附件位于 `<files>/.tcymc-ai/conversations/<uid>/attachments/<sha256>.enc`，AES-GCM 加密，AAD 绑定账号和文件标识，密钥沿用会话配置。文件名仅是元数据。会话保存草稿和每轮消息的有序引用，模型历史只保存引用，发送时临时读取并编码图片。

同一账号的相同内容复用一份加密文件，分支不复制附件。删除会话或移除草稿后，只有确认其他会话均不再引用才回收；遇到不可读的会话则保守停止回收。删除会话不撤销已经执行的任务变更。

占用显示加密会话文件与不同附件文件的实际字节数，包含草稿、摘要、工具回执和恢复状态。共享附件在每个引用会话里计一次，因此不能把各会话数字相加当作独占物理占用。丢失文件计入引用数量，不计入附件字节数。不以 token 数或字符数估算硬盘大小。

所有附件接口只允许当前人类账号访问，无公开链接，不向 MCP、API token 或项目分享授权开放。聊天附件不自动变成项目公开附件。普通文件可存储、下载、导出；UTF-8 纯文本向模型提供最多 64,000 字节的明确标注预览；其他文件只提供元数据，不伪称模型已阅读 PDF、Office 或压缩包。图片支持 PNG/JPEG/WebP/GIF；GIF 发给模型时转成首帧 PNG，原文件保留。

单文件 32 MiB、每条消息 16 个附件、图片 5,000 万像素、ZIP 附件总量 256 MiB 是文件处理保护值，与模型输出 token 预算无关。服务商可能另有图片限制，服务商错误继续进入现有调试窗口。

## 导出

- JSON：公开会话 DTO，不含密钥、provider 原生签名或内部恢复上下文。
- Markdown：按消息顺序保留正文和相对附件引用。
- ZIP：`conversation.md`、`conversation.json`、`attachments/<id>/<name>`，相同文件只打包一次。
- PDF：浏览器本地生成 A4 文档，中文字体、页码、可选择文字、表格、代码和工具记录；图片位于原消息处。PDF 图片最长边限制为 2200 像素以控制体积；ZIP 保留原文件。丢失图片明确标记，其他附件显示名称。不会抓取 Markdown 中任意远程图片 URL。

PDF 使用按需加载的 pdfmake；Noto Sans SC 字体从本站加载，OFL 许可证位于 `frontend/public/fonts/`。不会把会话发给第三方转换服务。运行中导出保存快照，不停止后台任务。

协议依据：[OpenAI 图片输入](https://developers.openai.com/api/docs/guides/images-vision)、[Anthropic Vision](https://platform.claude.com/docs/en/build-with-claude/vision)、[Gemini 图片理解](https://ai.google.dev/gemini-api/docs/image-understanding)。PDF 依据：[pdfmake 客户端](https://pdfmake.github.io/docs/0.3/getting-started/client-side/)、[自定义字体](https://pdfmake.github.io/docs/0.3/fonts/custom-fonts-client-side/url/)。


### 模型请求中断恢复

`pkg/modules/tcyai/recovery.go` 在完整工具回复边界判断能否恢复，`ChatTurn.retryable` 仅对最新可恢复失败轮次为真。`POST /ai/conversations/{id}/review` 的 `retry` 决策继续同一 turn：后台重新校验身份与业务权限，使用原连接及原执行策略。`AgentState` 保留完整消息、已加载工具与操作凭据，模型请求前写入检查点；不能把未确认的写操作当成待重试 HTTP 请求。旧版本的状态可从服务端保存的上下文与配置恢复，客户端不能提交工具执行结果。流式活动与完整会话 API 返回同样的可恢复标志。浏览器只观察后台任务，刷新/断线不会重新执行。
