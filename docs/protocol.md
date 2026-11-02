# prompt-polish 内部协议与实现说明（v2）

面向维护者。用户向的说明见 [README](../README.md)；设计裁决见 [design-v2](design-v2.md)。

## 1. 组成

| 半边 | 文件 | 运行位置 | 职责 |
| --- | --- | --- | --- |
| Host | `index.js` | Harness 主进程 | 注册一条精确 Fetch 路由，校验请求信封，把结果包成 JSON |
| Host | `optimize.js` | Harness 主进程 | 解析会话路由、采集上下文与附件、发一次 `llm` 调用、净化正文、解析 PLAN |
| Client | `client.js` | 浏览器 | 三个槽位：按钮、骨架屏、诊断面板；发请求、写回草稿、撤回、澄清重跑 |

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
  "text": "输入框里的草稿纯文本",          // 澄清轮里是「最初那段草稿」，不是上一版改写结果
  "attachments": [                        // 可能缺省或为 []
    { "type": "image", "mediaType": "image/png", "data": "<规范 base64，无 data: 前缀>", "name": "image.png" },
    { "type": "file",  "receiptId": "<FileUploadReceiptId>", "name": "notes.md", "bytes": 1234 }
  ],
  "answers": [ { "q": "改哪个文件？", "a": "client.js" } ]   // 可缺省；≤6 条，重复 q 取最新
}
```

- `type:"image"` 的 `data` 由 Composer 自己的 `encodeImage` 产出；`mediaType` 限于
  `image/png|jpeg|webp|gif`。
- `type:"file"` 的 `receiptId` 来自后台文件上传队列，与用户此时点发送会提交的是同一个 id。
- `answers` 由诊断面板的候选项点击产生，Host 侧逐条重新校验（见 §6）。
- 所有字段都视为不可信输入。

### 响应体（两种结果都是 HTTP 200）

```jsonc
{
  "ok": true,
  "text": "<改写后的提示词正文>",
  "model": "<模型 id>",
  "route": "request-header|session-selection|default-selection",
  "format": "envelope|json|xml|plain",
  "plan": {                              // null = 模型没给可用的 PLAN，页面按 v1 行为
    "type": "coding|writing|analysis|image|other|''",
    "notes": "一句话改动说明（可空）",
    "assumptions": [ { "slot": "输出格式", "value": "Markdown 表格" } ],
    "questions":   [ { "q": "改哪个文件？", "options": ["client.js", "optimize.js"] } ]
  }
}
{ "ok": false, "message": "<中文失败原因>" }
```

只有信封本身非法（非 JSON、缺 `sessionId`）才返回 400。`route`/`format` 是附加诊断字段
（页面不读，测试与日志用）。`plan` 只承载"已补的"与"要问的"两类信息，正文永远在 `text`。

## 3. 上下文从哪来

改写请求带三类上下文，全部只读，且**每一类都可以为空**——会话刚建立、一条消息都没发过时，
改写照常工作，只是没有历史与附件。

1. **模型路由**（三层回退）：会话自己的请求记录 → 会话当前模型选择（`pending ?? lastUsed`）
   → 部署默认模型。没有上下文不是拒绝的理由，只有三层都解析不出模型时才会失败。
2. **对话历史**：`session.deriveMessages()` 里最近 6 条 user/assistant 消息，只取文本块，
   单条 1500 字符、合计 6000 字符（从最新往回占预算），`JSON.stringify` 后放进用户消息，
   用 JSON 边界防止草稿伪造分隔符。一条都没有时不生成这一段，也不留空占位。
   **草稿本身也用 `JSON.stringify` 包**（同理防越界），所以用户消息里紧跟着一句「不要沿用这个
   包装：不要加引号、不要把换行写成 `\n`、不要写成 JSON」——不写这句，模型会照抄它看到的形状，
   把整段答案回成一个转义过的 JSON 字符串。
3. **输入框附件**：图片经 `ctx.attachments.admitPromptContent()` 拿持久引用，仅当
   `PreparedLlmCall.inputModalities` 含 `'image'` 时作为 `{type:'image', attachment}` 块随请求
   发出；文本类文件读前 8 KB（合计 24 KB）；其他文件只给名称与字节数。无论能否读到正文，
   都会生成一段「附件清单」，逐项写明模型是否真的看得见内容。

## 4. 一次调用

```
prepareCall({ provider, model, reasoningEffort? }, signal)
  → 展开 call.config 原样传给 call.stream({ ...call.config, messages, system, sessionId, signal })
  → 消费 text-delta 累积文本（无 delta 的适配器用 block-end 兜底），记录终止 finish
  → sanitizeOutput: 结构化提取 → 剥 PLAN 记录行 → 格式清理 → 元信息截断
  → parsePlan: 单独解析诊断块
```

`call.stream()` 在派发前会比对 `provider/model/reasoningEffort/temperature/maxTokens`
是否与 prepare 时一致（`INVALID_PREPARED_CALL`），所以必须展开 `call.config`。
`purpose` 只允许 `'compaction' | 'session-title'`，这里不传。

## 5. 模型侧回答契约

系统提示词要求模型只输出两块：

```
[[PROMPT_BEGIN]]
（改写后的提示词正文，唯一会写进输入框的东西）
[[PROMPT_END]]

[[PLAN_BEGIN]]
TYPE: coding
NOTE: 补了验收标准，删掉重复描述
ASSUME: 输出格式 => Markdown 表格
ASK: 改哪个文件？ => client.js ;; optimize.js
[[PLAN_END]]
```

- PROMPT 块之外的一切（开场白、说明、寒暄、备选版本）照旧丢弃；PROMPT 缺 END 时在
  `[[PLAN_BEGIN]]` 处截断。
- PLAN 是**行记录**：`TYPE/NOTE/ASSUME/ASK` + `:`/`：`；`ASSUME`、`ASK` 用 `=>`（也接受
  `->`、`→`）分隔两侧，候选之间用 `;;`。
- **不用 `|` 当分隔符**：中文提示词里表格竖线极常见。只有在整行一个 `;;` 都没有时，
  才退回按 `|` 切分（宁可救回问题，也不静默丢光候选）。
- 占位符（`{{var}}`、`<YOUR_NAME>`、`${x}`、`[TODO: …]`）在提示词里是"故意留空"，
  属于已完整，既不算缺口也不许补。

## 6. 解析、上限与降级

`sanitizeOutput(raw)` 只决定正文：

| 顺序 | 步骤 | 说明 |
| --- | --- | --- |
| 1 | `extractEnvelope` | 标记容错：前后 `**`/```/空白、大小写、缺 END |
| 1b | `stripPlanRecords` | 模型把 PLAN 行写进正文时按行前缀剔除（`ASSUME:`/`ASK:`/`TYPE:`/`NOTE:`） |
| 1c | `unwrapFenceShell` / `extractJsonString` | 「改写后的 JSON 字符串：」这类**宣告行 + 单个围栏**，以及围栏内的**顶格 JSON 字符串**：先剥壳再解码 `\"` 与 `\n`。仅当围栏/引号之外没有正文、且宣告行不像「输出格式：」这类格式标签时才剥 |
| 2 | 格式清理 | 解码 `\n` 转义、去整体围栏、去开场白行、去包裹引号 |
| 3 | `cutMetaSections` / `cutTrailingAdvice` | 「改动说明/更短的版本/如果…建议…」等兜底截断 |
| — | 降级 | 信封 → 顶层 JSON 字符串 → `{"prompt": …}` JSON（含手写容错）→ `<prompt>` → 纯文本 |

`parsePlan(raw)` 决定诊断，全部字段都在这里被裁剪（`PLAN_LIMITS`）：

| 限制 | 值 | 越界行为 |
| --- | --- | --- |
| 补全条数 | 6 | 多余丢弃 |
| `slot` / `value` | 10 / 30 字 | 截断加 `…` |
| 问题条数 | 3 | 多余丢弃（模型被要求按影响排序，故保留靠前的） |
| 问题 / 候选 | 20 / 4×12 字 | 截断；候选去重 |
| `notes` | 120 字 | 截断 |

单条记录的失败只影响那一条：缺箭头、缺一侧、未知 TYPE、只有一个候选的问题、光有槽位没取值
的 ASSUME 全部**整条丢弃**。整块缺失、全坏、或只有 TYPE/NOTE 而没有补全与问题 →
`plan: null`，页面表现与 v1 完全一致（**降级不是失败**）。

## 7. 澄清轮

`answers` 非空时，用户消息里追加一段（正文仍是最初草稿）：

```
【用户已确认（权威事实，优先于任何推断；不要就这些再提问，也不要写成"假设/待确认"）】
- 改哪个文件？ → client.js
下面的草稿就是最初的草稿：请据它重新改写一遍，把上面的确认项写成提示词里的硬约束。
```

- **从最初草稿重写**，不是在被改写的文本上再改一遍——避免措辞漂移与约束丢失。
- 答案经 `parseAnswers` 校验：非对象/空 q/空 a 丢弃，同 q 取最新，最多 6 条。
- 第二轮不再提问已回答的项；模型仍给了 PLAN 就刷新面板，没给就 `plan: null`、
  面板消失（旧诊断描述的是上一版正文，留着会误导）。

## 8. 非模型可见性

- 不 append 任何会话事件，不创建消息，不改附件，不动附件 dock。
- 图片 admit 只是内容寻址存储写入，不产生可见消息。
- 附件是「读懂草稿」的背景，系统提示词明确禁止把附件内容搬进改写结果。

## 9. 客户端实现要点

- 三个槽位：`conversation.input.activity`（按钮）、`conversation.input.overlay`（骨架屏，
  id `prompt-polish-skeleton`）、`conversation.input.dock`（诊断面板，id `prompt-polish-plan`，
  order 6；与 QueueDock/TodoDock 同座，全宽、在输入卡片上方）。
- 状态按 session 存在一个不可变 store 里，由 `ctx.effect` 拥有：
  `idle | pending(mode: polish|refine) | done(plan, answers, planHidden, applied, error)`。
  **切会话不取消请求**：请求归属发起它的 session，切走后继续跑完，结果只写回那个 session。
- 写回由**该 session 自己的组件实例**在渲染时执行（effect），`applied` + `appliedRef` 保证
  只写一次；`seen` 声明在写入 effect **之前**（同一 commit 里两个 effect 都可能跑，
  判定必须看到写入之前的草稿）。
- 同一个 session 单飞：`begin()` 只从 `idle` 起，`beginRefine()` 只从 `done` 起，
  任何在途状态下的点击都是 no-op。
- 点候选项 → `beginRefine()` → `POST { text: <最初草稿>, answers: [...已确认, 本次] }`；
  与首次优化共用 `sendOptimizeRequest()`（同一份 timeout / abort / 跨会话 / liveness 逻辑）。
- 发起会话消失（关闭/删除）：完成时用会话目录快照校验，不在目录里就静默丢弃。
- 骨架屏用 `[data-composer-overlay]` → `[data-composer-card]` → `[data-composer-input]`
  量编辑器矩形（裁到可见框），`ResizeObserver` 跟随，bar 数按 24px 行距由高度推导。
- **骨架屏首帧不画猜测值**：`top`/`height` 只有量出来之后才用，测量完成前元素是
  `visibility:hidden`（挂载着、有真实 rect，但不会被看见）。`top/height` 过渡挂在
  `data-armed="true"` 上，该属性要等第一帧量好的画面画完才置上（`requestAnimationFrame`，
  无 rAF 时退化为 `setTimeout 0`），因此**初次落位是瞬时的**，只有后续真实 resize
  （用户仍在打字）才会有动画。估高只在宿主不暴露上述钩子时使用——那时不会再有"修正"，
  估高即终值。
- 面板只在 `done && plan && !planHidden` 渲染；`pending && mode==='refine'` 时收成一行。
  `×` 只收起面板，不影响 ↺。

## 10. 已知耦合

| 用于 | 接口 | 降级行为 |
| --- | --- | --- |
| 读附件字节 | `ConversationService.serializeDraftAttachments` | 本次改写不带附件 |
| 量骨架屏高度 | `[data-composer-*]` 属性 | 退回按草稿行数估算 |
| 图片入上下文 | `PreparedLlmCall.inputModalities` | 只给附件清单与尺寸 |

## 11. 测试

```bash
node test/run-all.mjs
```

六个离线 harness，不需要 Harness 运行实例、不联网：`client.smoke`、`client.behaviour`、
`client.plan`、`client.attachments`、`client.geometry`、`host.optimize`。
