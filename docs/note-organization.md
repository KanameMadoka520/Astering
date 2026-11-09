# 真实录音时间、自动入文与长文整理

这一页补充 [语音笔记](voice-notes.md)。录音与原始转录的持久化由采集端处理；整理功能只接受当前账户已保存的文字，不会取得项目、笔记或 MCP 工具权限。

## 分句导入契约

`POST /api/v2/notes/{id}/segments/import` 接受与普通分句追加相同的文字字段，并返回 `{segment, stats}`。只有当前笔记所有者的有效人类会话可使用；管理员、项目成员、API token 或阿罗娜工具授权均不能代替这一归属。采集端在第一次发送前固定分句 UUID；网络重试必须保持全部字段不变。

| 字段 | 含义 |
| --- | --- |
| `client_id` | 每个最终分句的固定 UUID。相同内容和元数据重试返回原行，不重复写入正文。 |
| `recording_id` | 一次真实采集 run 的 UUID；与 note 和模型连接无关。 |
| `recording_started_at` | 设备真正开始采样时的 UTC RFC3339 日期。点击按钮、连接完成、入库时间都不能冒充它。 |
| `recording_offset_ms` | 分句在当前 run 中的采样起点，相对上述真实采样起点。 |
| `captured_at` | 可直接提供真实 UTC 日期。存在录音起点时，必须等于起点加 run offset；服务器派生同一个值。 |
| `timezone` | 采集时的 IANA 时区，例如 `Asia/Shanghai`。显示时可按账户偏好的时区转换同一时刻。 |
| `start_ms` / `end_ms` | 请求的分句持续时间。import 会用固定 run origin 加 `recording_offset_ms` 生成整篇笔记的权威累计坐标；客户端以回复为准。旧的普通追加端点仍按原有累计坐标工作。 |
| `append_to_article` | 采集时记录的可选开关快照，默认关闭。重试不能因为账户偏好后来改变而修改这一字段。 |
| `article_appended` | 服务器只读回执。若请求自动入文但该字段为 false，说明正文达到容量上限；原始分句仍然已保存。 |

首次导入某个 run 时，服务器在笔记写锁内读取当前最大 `end_ms` 固定 run origin。后续通过该 run 首行的 `start_ms - recording_offset_ms` 复用它，因此其他设备后续追加、离线恢复或重试不会不断改变坐标。分句持续时间保持 `end_ms - start_ms`，不把累计 note offset 当作真实时间。

真实日期列用 `time.Time` 与 `datetime(3)`，归一化到 UTC 毫秒后保存并读回；SQLite、PostgreSQL、MySQL 均保留幂等比较所需的毫秒精度。历史没有真实采样起点或日期的数据仍然没有日期，界面显示“录制日期未知”，不使用 `created` 入库日期补造历史。

实时 WS 的 `start` 支持同一组 run 元数据，其中 `recording_offset_ms` 表示当前 wire 的第一个采样相对 run 的起点。最终分句再加服务商的 wire 内偏移。原生端在服务商 ready 后才开麦时，可在第一个二进制 PCM 帧之前发送一次 `{"action":"capture_started","recording_started_at":"...Z"}` 修正真实起点；只允许 run offset 为零的首 wire。已有音频或后续轮换不能改写 run 起点。服务端通过共享时钟锁取得快照，避免控制帧与分句落库竞态。

## 自动入文与编辑冲突

原始分句与自动正文追加在同一短事务中完成，追加到最新已保存正文末尾并推进 `revision`。重复 UUID 在追加前匹配原始记录，因此不会再次插入同一句。未开启自动入文时保持原有“转录不推进正文 revision”的行为，也不会为每句话读取整篇文章。

回执的 `stats.article_revision` 触发文章详情的定向读取，而不是把新版本号贴到旧缓存文字上。编辑器存在未保存手稿时保留手稿并进入现有对比冲突流程。服务器不会猜测用户是否想覆盖手稿，也不会降低 `expected_revision` 的保护。正文已满时优先保存不可变原始分句，返回明确的未入文标志。

## 后台整理与上下文边界

`/notes/{id}/organization` 管理每篇笔记最新一份整理任务。来源可选不可变原始转录的创建时 high-water mark，或当前保存文章的快照。后来新增的录音不会混入已开始的预览。用户选择自己的文字模型；空选择由该账户的整理连接或助手连接解析，密钥只从该账户原有加密设置读取，不保存在 job 内。

整理采用分片 map 与分层 reduce：

1. 依照已声明的模型上下文减去其输出额度和提示词余量计算输入预算。未知容量使用保守的调度策略，绝不宣称那就是模型真实容量，也不降低用户明确配置的输出上限。
2. 原始录音按 cursor 分批读取最多 16 句和必需列，保存分句内字节 offset；UTF-8 边界安全拆分较长单句。单个请求缓冲最大 512 KiB，服务商 token 数另按真实 usage 统计。
3. 每个完整成功的 map 响应都保存检查点，然后才推进来源 cursor。失败或截断的输出不进入摘要集合。
4. reduce 每次只合并当前预算内的有序摘要组，保存下一层中间结果。只要尚未收敛，就逐层继续，不把所有原文重新塞回最终请求。
5. 服务商报告输出截断、空结果、无法收敛或摘要大于合并预算时暂停并解释原因；不按字符截断后假称完整。原文始终保留。

来源文本始终是低权限的 user 数据，system 明确禁止把来源中的指令变成执行要求。模型调用 `Chat(..., nil tools)`，不存在项目写入、MCP 或自动笔记工具副作用。模型返回内容通过现有 Markdown 净化渲染，外链沿用阿罗娜的安全链接交互。

参考了成熟项目的两个独立边界：[LangMem 的独立 running summary 与原始消息状态](https://langchain-ai.github.io/langmem/guides/summarization/)，以及 [LlamaIndex TreeSummarize 的预算内重打包和递归汇总](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/response_synthesizers/tree_summarize.py)。Astering 使用现有 Go provider 和 SQL 持久化实现相同的边界，不额外引入一套 Python agent 框架。

## 生命周期、采用与空间

任务在服务器后台执行，离开页面不会停止。当前会话对应的账户停用、删除、凭据撤销和显式停止仍会终止执行。检查点写入同时核对 owner、note、原始凭据、attempt generation 和 active 状态，旧 worker 不能把取消或重试覆盖成完成。

整理有独立的资源准入：每账户同时最多 2 个，全实例最多 32 个，预留中的创建／重试也计入。名额在写入 job 事务前预留，满额返回 `429` 与 `Retry-After: 5`，不创建等待中的孤儿任务、不改变原检查点，也不建立无界后台排队。取消后须等模型请求及监测协程实际退出才释放名额；事务或启动失败会释放尚未接管的预约。该限制不限制 Token、上下文或不同聊天会话的独立执行。

服务器重启后不自动再次产生模型费用：界面将失去 worker 的 active 行标为 `interrupted`，由本人明确选择“从检查点继续”。失败重试只重复未完成请求，已完成片段保留；若服务商在断线前已消耗 token，却没有返回完整响应，这部分使用量无法凭空恢复，可能发生重复请求费用。模型配置变更后的重试重新读取该账户连接，并显示实际模型。

完成后只显示 Markdown 预览，用户明确选择追加或替换并再次确认，服务器核对当前 `expected_revision`。未保存草稿先保存或处理冲突。原始转录不因采用结果而改变。

每篇笔记仅保留最新一份整理预览及检查点，避免隐藏历史无限增长。`storage_bytes` 记录来源快照、检查点、预览及错误的逻辑 UTF-8 字节，计入个人空间的 `note_organization_bytes` 和 `note_text_bytes`，独立于实体文件的 `total_bytes`。完成后清掉不再需要的文章来源快照；预览可以单独“清理整理预览与检查点”，不删除正文与原始转录。删除笔记或账户会同步删除 job。账户 ZIP 导出逐篇写入 note JSON、分句 JSONL 和 organization JSON（含尚需恢复的来源与检查点），不导出原始 session 标识或模型密钥。数据库逻辑数据减少不代表数据库文件立即收缩。

## 验证

模型测试覆盖真实时钟与幂等 origin、自动入文并发版本保护、正文满容量不丢原文、用户隔离、取消与旧 generation 拦截、显式采用、原始数据删除及空间清点。provider mock 测试覆盖长文 map/reduce、默认协议输出截断、无工具定义、真实 usage、取消和进程中断，并校验跨 UTF-8 分句的有界分页不丢字。

Playwright 的 `notes/capture-clock.spec.ts` 与 `notes/organization.spec.ts` 在桌面和手机宽度使用真实 API 和数据库。整理测试仅把模型替换为仓库公开的本地 TLS fixture，验证离页继续、预览前不改文章、确认后真实采用及单独清缓存。需沿用阿罗娜 fixture CA 与 `ASTERING_OUTGOINGREQUESTS_ALLOWNONROUTABLEIPS=true` 的隔离测试 opt-in；不使用真实付费密钥。统一由 `mage test:e2e` 执行。
