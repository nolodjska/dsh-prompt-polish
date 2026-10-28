# prompt-polish 内部协议与实现说明

面向维护者。用户向的说明见 [README](../README.md)。

## 1. 组成

| 半边 | 文件 | 运行位置 | 职责 |
| --- | --- | --- | --- |
| Host | `index.js` | Harness 主进程 | 注册一条精确 Fetch 路由，校验请求信封，把结果包成 JSON |
| Host | `optimize.js` | Harness 主进程 | 解析会话路由、采集上下文与附件、发一次 `llm` 调用、净化输出 |
| Client | `client.js` | 浏览器 | 注册按钮与骨架屏两个槽位，发请求、写回草稿、提供撤回 |

客户端不能 import 任何 Harness Client 包，因此两侧只通过下面这条 HTTP 契约通信。

## 2. 线协议

### 路由

```
POST /api/prompt-polish/optimize      requestBody: buffered
```

走 Harness 的共享 `/api` 桥（与 Web GUI 同源，靠浏览器会话 cookie 认证），Host 侧用
`ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered' })` 注册。
插件没有 Typert `/remote` 代码生成，所以精确 Fetch 路由是普通插件唯一可用的同源通道。

### 请求体

```jsonc
{
  "sessionId": "session-7",
  "text": "输入框里的草稿纯文本",
  "attachments": [                       // 可能缺省或为 []
    { "type": "image", "mediaType": "image/png", "data": "<规范 base64，无 data: 前缀>", "name": "image.png" },
    { "type": "file",  "receiptId": "<FileUploadReceiptId>", "name": "notes.md", "bytes": 1234 }
  ]
}
```

- `type:"image"` 的 `data` 由 Composer 自己的 `encodeImage` 产出；`mediaType` 限于
  `image/png|jpeg|webp|gif`。
- `type:"file"` 的 `receiptId` 来自后台文件上传队列，与用户此时点发送会提交的是同一个 id。
- 所有字段都视为不可信输入。

### 响应体（两种结果都是 HTTP 200）

```jsonc
{ "ok": true,  "text": "<改写后的提示词>", "model": "<模型 id>", "route": "request-header|session-selection|default-selection" }
{ "ok": false, "message": "<中文失败原因>" }
```

只有信封本身非法（非 JSON、缺 `sessionId`）才返回 400。`route` 是附加的诊断字段（模型由哪一层
解析出来），页面不读它，测试与日志使用。

## 3. 上下文从哪来

改写请求带三类上下文，全部只读，且**每一类都可以为空**——会话刚建立、一条消息都没发过时，
改写照常工作，只是没有历史与附件。

1. **模型路由**（三层回退，见下）：优先用会话自己的请求记录；会话还没有任何请求记录时，
   退到它当前的模型选择，再退到部署默认模型。**没有上下文不是拒绝的理由**，只有三层都
   解析不出模型时才会失败。
2. **对话历史**：`session.deriveMessages()` 里最近 6 条 user/assistant 消息，只取文本块，
   单条 1500 字符、合计 6000 字符（从最新往回占预算），`JSON.stringify` 后放进用户消息，
   用 JSON 边界防止草稿伪造分隔符。**一条都没有时不生成这一段**，也不留任何空占位。
3. **输入框附件**：
   - 图片经 `ctx.attachments.admitPromptContent()` 拿到持久引用，仅当
     `PreparedLlmCall.inputModalities` 明确含 `'image'` 时作为 `{type:'image', attachment}`
     块随请求发出；否则只在清单里描述名称与尺寸。
   - 文本类文件经 `ctx.fileUploads.resolve(agent, receiptId)` →
     `ctx.attachments.readFileStream()` 读前 8 KB，合计上限 24 KB。
   - 其他文件只给名称与字节数。
   - 无论能否读到正文，都会生成一段「附件清单」，逐项说明模型是否真的看得见内容。

## 4. 模型路由的三层解析

`resolveModelRoute(ctx, session)` 按顺序取第一个能解析出 `provider`/`model` 的来源：

| 层 | 来源 | 何时命中 |
| --- | --- | --- |
| 1 | `session.requestHeader().config` | 会话已发过消息，日志里有请求记录（最准确，等于"同一个模型"） |
| 2 | `ctx.get('sessionProjections').stateOf(session,'modelSelection')` 的 `pending ?? lastUsed` | 会话还没有请求记录，但用户已经在输入框旁选过模型 |
| 3 | `ctx.get('agentDefaultModel').currentSelection()` | 全新会话，连选择都没有：用部署默认模型 |

第 2、3 层通过 `ctx.get()` 取，属于可选服务：profile 里没有它们时该层直接跳过，
不影响插件激活。`reasoningEffort` 一并透传进 `prepareCall`，所以改写用的思考档位
与输入框显示的一致。三层都取不到才返回 `ok:false`（"还无法确定用哪个模型"）。

## 5. 一次调用

```
prepareCall({ provider, model, reasoningEffort? }, signal)   // 绑定适配器、物化适配器默认值
  → 展开 call.config 原样传给 call.stream({ ...call.config, messages, system, sessionId, signal })
  → 消费 text-delta 累积文本，记录终止 finish
  → sanitizeOutput: 去掉整体代码围栏 / 开场白行 / **夹带的说明与备选版本** / 尾部建议段 / 整体包裹的引号，截断到 20000 字符
```

`call.stream()` 在派发前会比对 `provider/model/reasoningEffort/temperature/maxTokens`
是否与 prepare 时一致（`INVALID_PREPARED_CALL`），所以必须展开 `call.config`，不能自己另写一份。
`purpose` 只允许 `'compaction' | 'session-title'`，这里不传。

### 输出净化：多余内容不能进输入框

模型偶尔会把「更短的版本／改动说明／给你的建议」一起吐出来，而这些会被原样放回输入框、
随下一条消息发给模型。两道防线：

1. **系统提示词第 9、10 条**明确禁止：改动说明、改写理由、与原句对比、备选版本/方案二、
   对草稿的点评、给用户的建议、任何提问；只给一个版本，最后一行就是提示词的最后一句话。
2. **`cutMetaSections()` / `cutTrailingAdvice()`** 兜底：
   - 在**行首**匹配一组窄标签（改动说明、改写说明、变更点、更短的版本、备选方案、版本二、
     验收基准建议…），命中即从该行截断；横向分隔线只有在**下一段是引言或元信息块**时才截断，
     所以提示词自身用 `---` 分节不会被误砍；
   - 单纯标签（说明/注意/备注/建议/理由）只有在**整行只有标签**时才算元信息，
     `注意：不要修改现有测试` 这种句子照旧保留；
   - 末尾单独一段若以「如果/若/建议」开头且含「建议/验收/补充/执行方」等词，视为给你的指点丢掉。
   - 整篇都是元信息（首行即命中）时返回空 → 报「模型没有返回可用的提示词」，绝不把说明当提示词发出去。

## 6. 非模型可见性

- 不 append 任何会话事件，不创建消息，不改附件，不动附件 dock。
- 图片 admit 只是内容寻址存储写入，不产生可见消息；未被引用的对象由后续回收策略处理。
- 附件是「读懂草稿」的背景，系统提示词明确禁止把附件内容搬进改写结果。

## 7. 客户端实现要点

- 注册两个槽位：`conversation.input.activity`（工具行单槽，模型选择器右边）与
  `conversation.input.overlay`（卡片内浮层，id `prompt-polish-skeleton`）。
- 状态按 session 存在一个不可变 store 里，由 `ctx.effect` 拥有。**切会话不取消请求**：
  请求归属发起它的那个 session，切走后继续在后台跑完；只有插件卸载（`ctx.effect` 释放）
  才会 abort。
- 结果写回**发起会话**：完成时只把 `{phase:'done', written, original, applied:false}` 记进
  该 session 的条目；真正调用 `inputActions.setDraft()` 的是**该 session 自己的那个组件实例**
  在渲染时执行的 effect。组件按 session 渲染，所以当用户在别的会话时不会有任何写入；切回来
  的那一帧才写，且 `applied` + 同步的 `appliedRef` 双重保证只写一次。
- 撤销判定（`seen`）声明在写入 effect **之前**：同一 commit 里两个 effect 都可能跑，判定必须
  看到"写入之前"的草稿，否则一次重入渲染会让它误以为用户改过、把刚写好的结果丢掉。
- 同一 session 单飞：`store.begin()` 在非 idle 时直接返回 null，所以连点、切走再切回都不会
  重复发起或并发写入。
- 发起会话消失（关闭/删除）：完成时用 `useSessions` 的目录快照校验
  （`byId[id] !== undefined`，目录为空时按"仍存在"处理，宁可不丢结果），不在目录里就
  `store.discard()` —— 静默丢弃，不写草稿、不弹错误、不影响其他 session 的状态。
- 附件通过 `ctx.get('conversation').serializeDraftAttachments(ids)` 取得线格式，整批原子：
  只要有一个文件还在上传，这一次就整体跳过附件（日志记录，不打扰用户）。
- 骨架屏用 `[data-composer-overlay]` → `[data-composer-card]` → `[data-composer-input]`
  量出编辑器矩形，`ResizeObserver`（编辑器 + 卡片）跟随，bar 数按 24px 行距由高度推导；
  量不到时退回按草稿行数估算。
- 量出的矩形必须**裁到可见框**：编辑器 `[data-composer-input]` 会随草稿无限增高，而宿主把它
  裁在一个滚动容器里（`.GRgSLq_scroll{max-height:var(--dsh-composer-text-max-height);overflow-y:auto}`），
  所以它的 rect 往往远高于屏幕上的可见高度。做法是从编辑器沿 `parentElement` 走到卡片，
  取所有祖先里**最高的 top 与最低的 bottom**（再并上卡片自身），得到的就是真实可见区域；
  没有裁剪层时祖先只会更大，钳制自然不生效，因此不需要依赖任何哈希类名。
- bar 数量的取整方向是**向下**：`n` 条占 `n*10+(n-1)*14 = 24n-14` 像素，向上取整会让最后一条
  探出量出的盒子、被 `overflow:hidden` 削掉半行。

## 8. 已知耦合

以下三处是宿主内部实现细节，不是公开契约。宿主改名或改签名时会**降级**而不是崩溃：

| 用于 | 接口 | 降级行为 |
| --- | --- | --- |
| 读附件字节 | `ConversationService.serializeDraftAttachments` | 本次改写不带附件 |
| 量骨架屏高度 | `[data-composer-*]` 属性 | 退回按草稿行数估算 |
| 图片入上下文 | `PreparedLlmCall.inputModalities` | 只给附件清单与尺寸 |

## 9. 测试

```bash
node test/run-all.mjs
```

五个离线 harness，不需要 Harness 运行实例、不联网：

| 文件 | 覆盖 |
| --- | --- |
| `client.smoke.mjs` | 模块加载、槽位注册、locale 词典、effect 数量 |
| `client.behaviour.mjs` | 四个 UI 状态、撤回、编辑失效、会话切换、空草稿 |
| `client.attachments.mjs` | 附件采集/上限/线格式、序列化失败降级、dock 只读审计 |
| `client.geometry.mjs` | 骨架屏跟随编辑器矩形、bar 数随高度、无尺寸时回退 |
| `host.optimize.mjs` | 路由解析、上下文摘要、附件、全部失败分支、超时/取消、零 append |
