# prompt-polish v2 设计（锁定稿）

> 本文件是 v2 的实现契约。改行为先改这里，再改代码。
> 目标：把「改写提示词」从**只判意图**升级为**判意图 → 体检缺什么 → 该补的补、该问的问 → 交出可直接执行的提示词**，
> 同时保持小而美：**不新增服务、不新增路由、不新增依赖、不新增文件**，默认仍是一次辅助调用。

## 0. 一句话

| | v1 | v2 |
| --- | --- | --- |
| 做什么 | 把草稿改通顺、补结构 | 先按任务类型体检，再改写：**结构化补齐 + 有界澄清** |
| 看不见的信息 | 「保持克制，不要编造，也不要问」 | 分两类：结构类→补并**告知**；事实类→**问**（≤3，带候选） |
| 用户能否纠正 | 只能撤回或自己改 | 面板列出「补了什么 / 还差什么」，**选中候选并点「确认并重写」**才按答案重写 |
| 调用次数 | 1 | 1（默认）；用户确认候选时 +1（多个问题合并成一次） |
| 组件数 | 1 按钮 + 1 骨架屏 | 1 按钮 + 1 骨架屏 + 1 面板（都挂在既有槽位，同一 store） |

## 1. 用户可见行为

1. 点 ✦（`conversation.input.activity`）：和 v1 一样，草稿就地变成改写后的提示词，按钮变 ↺。
2. 改写结果同时带一份**诊断**，渲染到输入卡片正上方（`conversation.input.dock`，id `prompt-polish-plan`，order 6）：

```
┌────────────────────────────────────────────────────────────┐
│ 已按「编码任务」补全 3 处 · 2 个待确认                  × │
│ 补全  输出格式=Markdown 表格  语言=中文  验收=给出可跑的测试 │
│ 待确认 改哪个文件？  [package.json] [client.js] [你说了算]  │
│        要不要保留旧接口？ [保留] [不保留]      [确认并重写] │
│ 改动   去掉了重复描述，补了验收标准                         │
└────────────────────────────────────────────────────────────┘
```

3. 点候选只**选中**（再点一次取消），全部选好后点「确认并重写」→ 就地再跑一次（草稿出现 spinner 骨架屏，面板转「按你的选择重写…」）→ 新提示词覆盖草稿，面板刷新（已答的项消失）。↺ 始终回到**用户最初那段草稿**。
4. 面板 × 只是收起面板，↺ 仍然可用；用户手动改动改写结果或直接发送，面板与 ↺ 一起失效（v1 已有规则）。
5. 没有诊断（模型没给 PLAN 块 / 全空）→ 面板不出现，行为与 v1 完全一致（**降级不失败**）。
6. 失败：面板消失、草稿不动、按钮旁一行中文提示（v1 规则不变）。

## 2. 线协议 v2

请求（`POST /api/prompt-polish/optimize`，v1 字段不变，新增 `answers`）：

```jsonc
{
  "sessionId": "session-7",
  "text": "用户最初那段草稿",            // 第二轮也发最初草稿，不发改写结果
  "attachments": [ /* v1 原样 */ ],
  "answers": [ { "q": "改哪个文件？", "a": "client.js" } ]   // 可缺省；≤6 条
}
```

响应（HTTP 200）：

```jsonc
{
  "ok": true,
  "text": "改写后的提示词正文",
  "model": "deepseek-v4.1-flash",
  "route": "request-header",           // v1 诊断字段
  "format": "envelope",                // 正文提取路径：envelope|json|xml|plain
  "plan": {                            // 可缺省（= null）；缺失不代表失败
    "type": "coding",                  // coding|writing|analysis|image|other
    "notes": "去掉了重复描述，补了验收标准",     // ≤120 字，可空
    "assumptions": [ { "slot": "输出格式", "value": "Markdown 表格" } ],  // ≤6
    "questions":   [ { "q": "改哪个文件？", "options": ["client.js", "optimize.js"] } ] // ≤3，options 2..4
  }
}
```

失败仍是 `{ "ok": false, "message": "…" }`。所有新字段都经过 Host 裁剪/限长，客户端不再二次校验。

## 3. 模型侧协议（系统提示词里的机器可读块）

系统提示词要求模型只输出两块，Host 各取所需：

```
[[PROMPT_BEGIN]]
（改写后的提示词正文，唯一会写进输入框的东西）
[[PROMPT_END]]

[[PLAN_BEGIN]]
TYPE: coding
NOTE: 去掉了重复描述，补了验收标准
ASSUME: 输出格式 => Markdown 表格
ASSUME: 语言 => 中文
ASK: 改哪个文件？ => client.js ;; optimize.js
[[PLAN_END]]
```

- 行前缀固定为 `TYPE:` / `NOTE:` / `ASSUME:` / `ASK:`；`ASSUME` 与 `ASK` 用 `=>` 分隔左右两侧。
- **不用 `|` 当分隔符**：中文提示词里表格竖线极常见（`| 列 | 列 |`），会被静默切错；候选之间用 `;;`，取值的左侧只切第一个 `=>`。
- **占位符不算缺口**：草稿里的 `{{variable}}`、`<YOUR_NAME>`、`${x}`、`[TODO:…]` 是用户留的运行时输入位，必须逐字保留，既不要补也不要问（v1 没有这条，v2 必须写死）。
- PLAN 块**整块不进输入框**；PROMPT 块之外的一切（开场白、说明、寒暄）照旧丢弃。
- 任何一行不合语法就丢掉那一行，不留垃圾（宁可少一条诊断，不可渲染坏行）。

## 4. Host 侧（optimize.js）

新增/改动：

1. `SYSTEM_PROMPT` 换成 v2 协议：见 §5。
2. `parsePlan(text)`：从 `[[PLAN_BEGIN]]…[[PLAN_END]]` 里按行解析，返回 `plan | null`。
   容错：标记前后 `**`/```/空白；缺 END 时到结尾或 `[[PROMPT_` 处截断；前缀大小写不敏感；全角 `：`；
   行首多余的 `-`/`*`/`>`；`ASK` 的候选用 `;;` 切分（整行没有任何 `;;` 时才退回 `|`）后逐项 trim、去空、去重。
   上限（Host 强制，模型再乱也炸不了 UI）：`notes` 120 字、`assumptions` 6 条、`slot` 10 字、`value` 30 字、
   `questions` 3 条、`q` 20 字、`options` 4 个、每个 `option` 12 字；空 `q` 的问题整条丢弃。
   这组数字与系统提示词里写给模型的字数上限**完全一致**（模型不必猜、也不会被裁剪），客户端另有一套
   更宽的上限作为第二道防线（防旧 Host 传出过长字段）。
3. `sanitizeOutput` 仍只负责正文；在提取后额外剔除正文里以 `ASSUME:`/`ASK:`/`TYPE:`/`NOTE:` 开头的行（防串块）。
4. `buildUserInput(digest, draft, attachments, answers)`：`answers` 非空时追加一段：

```
【用户已确认（权威，优先于任何推断）】
- 改哪个文件？ → client.js
```

   并要求第二轮**从最初草稿重写**，把已确认项写成硬约束。
5. `runOptimize` 返回值加 `plan`（`parsePlan` 的结果，null 表示没有）。
6. 常量集中：`PLAN_LIMITS`，其余 v1 常量不动。`MAX_DRAFT_CHARS`/超时/路由三层解析/附件采集全部保持。

## 5. 系统提示词 v2 结构（要写死的东西）

按顺序，五段，中文，其余全部删掉：

1. **角色与输出格式**：只输出 `PROMPT` + `PLAN` 两块；PLAN 语法逐行给样例；PROMPT 块内不许有解释/备选/点评。
2. **第一步：判定任务类型**（`coding|writing|analysis|image|other`），一句话定义各自边界。
3. **第二步：按类型体检**（每类 5~6 个槽位的清单，写死在提示词里）：
   - coding：目标文件/模块、技术栈与版本、现状与报错、改动边界、验收标准、兼容约束
   - writing：文体与用途、读者、语气与语言、长度、必须包含/避免、输出格式
   - analysis：对象与范围、判断标准、数据来源、输出形态、深度
   - image：主体与场景、风格与参考、构图/尺寸、光线与色调、禁止元素
   - other：目标、交付物形态、约束、完成判定
4. **第三步：两类缺口，两种处理**（这是 v2 的核心规则）
   - **结构类**（格式、长度、语言、语气、结构、验收标准、边界、优先级这类"做法"）：可以补 → 直接写进提示词当**硬约束**（不要写成"假设/可能"），同时记一条 `ASSUME` 让用户看见。
   - **事实类**（具体文件、路径、版本、数据、接口、人名、日期、外部事实）：**绝不编造**。能从"最近对话/附件"确定的，用上并记 `NOTE`；不能确定的，记 `ASK`（≤3 条，带 2~4 个具体候选，候选要短、能一键选，含一个"你说了算/让我自己填"式兜底）。
   - 只问**会改变提示词走向**的问题；措辞第二人称、≤20 字；同义重复只留一条。
5. **第四步：成稿要求**（保留 v1 里仍然对的条款）：原语言、原意图、逐字保留具体约束（路径/标识符/数字/命令/报错/验收）、不新增用户没要的任务、单版本、真换行、不用围栏/引号、指代消解。
6. **自检**（一次，不额外调用）：约束是否逐字保留？有没有把假设写成事实？PLAN 与正文是否一致（正文里出现的补全项要能在 ASSUME 里找到）？空草稿的边界（第一条消息）照常工作。

## 6. Client 侧（client.js）

- store（v1 单例，扩展字段，不新增 store）：
  - `pending`：加 `mode: 'polish' | 'refine'`、`answers`、`requestText`（用于重放）
  - `done`：加 `plan`、`answers`、`planHidden`
- 组件：
  - `PolishButton`（v1，不变）：pending 时 spinner；done 时 ↺。
  - `PolishSkeleton`（v1，不变）：只在 pending 播。
  - **新增** `PolishPlanDock`：`conversation.input.dock` id `prompt-polish-plan` order 6；
    仅当 `phase==='done' && plan && !planHidden` 渲染；`pending && mode==='refine'` 时渲染一行「按你的选择重写…」。
    点候选项 = 只写进组件本地 selection；点「确认并重写」→ `store.beginRefine(sessionId, [...已答, ...本次选中的全部])` → `POST { text: original, answers }`（一次请求带走所有已选答案） → 成功走 `succeed`，draft 由按钮组件的写入 effect 落地（v1 机制，复用不重写）。
- 写回与撤销规则不动：`original` 永远是最初草稿；`applied`/`seen` 的判定顺序保持 v1（顺序错了会吃掉刚写好的结果）。
- 文案：全部进 locale 词典（新增 `dock.*` 键），不硬编码中文到逻辑里。所有上限（展示条数、字符截断）在 client 侧也要有，Host 裁剪是第一道，client 渲染是第二道。
- 按钮禁用条件收敛为一条：`draft.trim().length < MIN_DRAFT_CHARS(4)`（比 v1 的"空草稿"多两字符，避免把 `hi`/`ok` 也送进模型）。

### 6.1 面板视觉规范（v2.1）

一屏五件事，从上到下就是阅读顺序；**形状承担层级**，不再所有东西都是胶囊：

| 行 | 结构 | 规约 |
| --- | --- | --- |
| 头 | `.pp-plan-type`（类型徽标，描边）+ `.pp-plan-summary`（`补全 N 处 · 待确认 N`）+ `.pp-plan-close`（×） | 类型不再写进句子；标题只留两个数字 |
| 补全 | `.pp-plan-tag` + `.pp-plan-chip`（`-k` 槽位灰 / `-v` 取值亮，无 `=`） | 长取值 60 字截断加 `…`，`title` 给全文 |
| 待确认 | `.pp-plan-tag` + `.pp-plan-asks` > `.pp-plan-ask`（`.pp-plan-q` + `.pp-plan-seg` > `.pp-plan-opt`） | 一问一行；选项共用边框成一组，`data-rec="true"` 用 ★ 标推荐（不再是独立徽标） |
| 底 | `.pp-plan-foot`：`.pp-plan-notes` 左 + `.pp-plan-progress`（`已选 1/2`）+ `.pp-plan-confirm` 右 | 面板里**唯一**的实心按钮；未选时 `disabled` 变描边 |
| 忙 | `.pp-plan-busy`：`.pp-plan-spinner` + 一行文案 + 灰掉的 chips | 高度压到最小，位置不跳 |

状态只用两个属性和两个类表达：`data-selected="true"`（实心 + ✓）、`data-rec="true"`（★）、`data-disabled="true"`（忙时灰）、`data-phase="done|refining"`。着色变量一律带字面量兜底（`var(--dsw-alias-state-business-primary,#a8c7fa)`），主题变量改名时面板会退化成可见色，而不是暗色文字压暗色底。

改样式后想直接看效果，不用起 Harness：`test/client.plan.mjs` 已经能把真实组件树渲染出来，把 `renderTree()` 打到 HTML 再从 `PLAN_CSS` 里取样式即可（本次改版就是这么验的）。

## 7. 测试（沿用离线 harness，不联网、不起 Harness）

| 文件 | 新增覆盖 |
| --- | --- |
| `test/host.optimize.mjs` | PLAN 解析（正常/装饰/缺 END/坏行丢弃/全角冒号/上限裁剪）、无 PLAN → `plan:null` 仍 ok、正文防串块剔除、answers 进入用户消息、第二轮不把改写结果当输入、prompt 常量含 v2 关键字 |
| `test/client.behaviour.mjs` | 现有 72 项全绿（回归）+ done 携带 plan、面板显隐、× 收起后 ↺ 仍在、点候选发出 `{text: original, answers}`、refine 失败回滚、切会话期间 refine 结果回原会话 |
| `test/client.plan.mjs`（105 项） | dock 槽位注册、空 plan 不渲染、长文案截断、**点候选只选中不发送**、确认后一次带走全部已选答案、单飞、切会话 |
| `test/client.smoke.mjs` | 槽位注册数从 2 变 3（或面板复用同文件内注册） |

验收：`node test/run-all.mjs` 全绿；`package.json`、`cordis.patch.yml` 零改动；`index.js` 仅加一行 `answers` 透传（v1 只转发 `sessionId/text/attachments`，与 §2 新增字段矛盾，已在 v2 修正）。

## 8. 明确不做（守住小而美）

- 不做多轮 agent 流水线、不做评估器、不做变量占位符系统、不做模板库/多模板切换。
- 不做 prompt 打分/对比、不做历史记录、不做设置面板。
- 不新增路由/服务/依赖/文件（除测试与文档）。
- 不在正文里保留「假设/待确认」字样（正文只放可直接发送的约束）。

## 9. 研究裁决（`docs/research-github.md` 落地后）

| 研究建议 | 裁决 | 理由 |
| --- | --- | --- |
| 输出契约改用 JSON | **不采纳**（正文仍用信封，诊断用行前缀块） | 正文必须是多行自由文本，JSON 字符串转义对模型不友好；行前缀块"坏一行丢一行"更抗偷懒。分隔符已从 `\|` 换成 `=>` / `;;` |
| 问题上限 1（单行 chip） | **采纳面板形态的 ≤3** | 研究 §4.2：约束本质是"轮数 ≤1"（同屏、点完一次重写），面板可放 3；单行 chip 才必须 ≤1 |
| 每个问题带"推荐"默认值 | **采纳** | `options[0]` 即推荐项，UI 上打「推荐」标；不提供自由输入（想自己写就改草稿再点 ✦） |
| 问题后跟一句 "Why it matters" | **不采纳** | 候选本身必须具体到能一键选，区分度在候选里；多一行 why 让面板高度翻倍，与"小而美"冲突。仅在 ASK 文本里保留必要限定（≤20 字） |
| 歧义固定词表（lexical/syntactic/semantic/referential + missing） | **部分采纳**：词表写进系统提示词当**内部判据**，不进响应体 | 用户不需要看"这是 referential 歧义"；但模型有了词表，"缺槽位"与"两种读法"才不会混为一谈 |
| `source: context\|default\|guess` | **不采纳** | 面板上"可不可信"由 value 本身与 NOTE 说清；再加一档只会引出阈值与图例 |
| 0 次调用的 genre 正则分类 | **不采纳**（类型由模型在 PLAN 里给） | 我们本来就要那次调用；正则分档是给"必须先分类再选模板"的实现用的 |
| 草稿 < 4 字符直接禁用 | **采纳** | 与"空草稿禁用"同一条线，`hi` 不需要优化；常量 `MIN_DRAFT_CHARS = 4` |
| `#skip` 逃生口 | **不采纳** | 按钮是显式动作，没有自动触发，不需要逃生口 |
| 模板库 / 模式选择 / 评估 / 打分 / 多版本 | **不采纳** | 见 §8 |

另外两条来自 linshenkx 的细则已并入系统提示词：**"优化 ≠ 回复"**（保持原提示词的说话人角色与语气，不许变成助手口吻）、**"适度优化"**（任何缺口都要能指出草稿里缺了哪一格，指不出就不是缺口）。

## 10. 证据来源

- 需求分析 → 结构化改写（角色/背景/步骤/输出要求、变量保留、禁止解释）：`linshenkx/prompt-optimizer` 的
  `user-prompt-planning.ts` / `user-prompt-professional.ts`（39.9k★，本仓库最接近的成熟实现）。
- 只输出提示词、用知识库强化改写、禁止夹带说明：`danielmiessler/fabric` 的 `improve_prompt`。
- 澄清提问 / 歧义分类 / 「先问再动」的证据与取舍：见 `docs/research-github.md`。
- 槽位语义：DSH 槽位表（`conversation.input.dock` = 输入卡片上方整宽条目，QueueDock/TodoDock/GoalDock 同槽）。
