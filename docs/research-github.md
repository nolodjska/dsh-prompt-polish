# 提示词优化的"意图 + 补全 + 澄清"——GitHub 成熟实现调研

面向 prompt-polish 下一版设计。引用均给路径与链接；未读到原文的标 **未验证**。每条最后都有"值得抄 / 是负担"。

## 1. 一页结论（TL;DR）

1. **主力路径 1 次调用，且这一次就产出可用提示词。** 四个"单次重写"实现（fabric、claude-prompt-improver、linshenkx 通用/上下文模式）都是 1 次；凡"先问再写"的多阶段实现（ClarifyGPT、PromptWizard、AutoPrompt）都依赖我们没有的东西——可执行测试、标注数据集、几十次迭代预算。所以**不要把提问变成必经步骤**。
2. **假设优先，提问兜底。** claude-prompt-improver 把 `- DO NOT ask questions or request clarification` 写成硬边界，因为它跑在提交路径上（阻塞即失败）；linshenkx 上下文模式也选择"补充必要信息"而非问。唯一解：**同一次回答里既给成品（已按推荐默认值补齐），又给 0–1 个可选的一键修正**。
3. **最多问 1 个问题。** spec-kit 的 5 问是长流程预算；gpt-engineer 的 clarify preprompt 三行里有一句 `Then you will pick one clarifying question, and wait for an answer from the user.` —— **pick one** 是"1 个"的直接依据。
4. **每个问题必须带推荐默认值、点一下即可、不用打字。** spec-kit：`**Recommended:** Option [X] - <reasoning>` 打头 + 2–5 项表格 + `accept the recommendation by saying "yes" or "recommended"`。落到我们：`options[0]` 即推荐项，chip 前缀「推荐」，**不提供自由输入**（想自己写就改草稿再点 ✦）。
5. **歧义分类用固定词表**（lexical / syntactic / semantic / referential，出自 [129_clarification.py](https://github.com/ayagup/genai-patterns/blob/main/langchain/129_clarification.py)）+ 我们补的第五类 `missing`。词表同时写进 system prompt 和 JSON `enum`，两边一起钉死。
6. **"补了什么"一行可见可撤，不新增面板。** 借 claude-prompt-improver 的强度：机械比对（0 次调用）产出≤3 条纯标签（`Added structure` / `Injected context` / `Expanded with detail`，兜底 `Enhanced clarity`）。
7. **输出契约：JSON 信封为主，现有 marker 兜底。** 要返回 4 组字段，`[[PROMPT_BEGIN]]` 只装得下一个；但现有三级降级是资产，**顺序反转为 JSON → 信封 → 纯文本**。
8. **明确砍掉**：模式选择器、模板库、变量提取、评估/对比/历史/收藏、多候选版本、rubric 打分——这七样 linshenkx 全有，正是它小而美不了的原因（见 §6）。

## 2. 来源清单

| 仓库 | 关键文件（链接） | 规模 | 成本（调用数） | 值得借鉴 | 不借鉴 |
| --- | --- | --- | --- | --- | --- |
| [linshenkx/prompt-optimizer](https://github.com/linshenkx/prompt-optimizer) 39.9k★，`develop` | [general-optimize.ts](https://github.com/linshenkx/prompt-optimizer/blob/develop/packages/core/src/services/template/default-templates/optimize/general-optimize.ts) · [analytical-optimize.ts](https://github.com/linshenkx/prompt-optimizer/blob/develop/packages/core/src/services/template/default-templates/optimize/analytical-optimize.ts) · [context-message-optimize.ts](https://github.com/linshenkx/prompt-optimizer/blob/develop/packages/core/src/services/template/default-templates/optimize/context/context-message-optimize.ts) | `default-templates/` 11 个模板族；仅 `optimize/` 10 个 ts（中英各半），单模板 2.3–7 KB | 1 次/次优化（评估、对比、迭代另算） | "适度优化原则"、`优化 ≠ 回复`、变量占位符逐字保留、上下文模式以对话证据代替提问 | 模板库 + 模式矩阵 + 评估/对比/收藏/历史 |
| [danielmiessler/fabric](https://github.com/danielmiessler/fabric) | [improve_prompt/system.md](https://github.com/danielmiessler/fabric/blob/main/data/patterns/improve_prompt/system.md) | 单文件，**内联 OpenAI《Prompt engineering》六策略教程全文**（万词量级，未精确计数） | 1 | `# STEPS` 三段式（先解释输入想干什么→再套知识→再产出） | 教程全文进 system prompt：每次点击按万词计费 |
| [GaZmagik/claude-prompt-improver](https://github.com/GaZmagik/claude-prompt-improver)（Claude Code 插件，可运行） | [improver.ts](https://github.com/GaZmagik/claude-prompt-improver/blob/main/hooks/src/services/improver.ts) · [prompt-genre.ts](https://github.com/GaZmagik/claude-prompt-improver/blob/main/hooks/src/services/prompt-genre.ts) | 提示词逻辑集中在 2 个 TS 文件（数百行）；另 11 类上下文集成 | 1（默认 haiku，60s） | 边界三连、genre 关键词分类（**0 次调用**）、机械 diff 摘要、短路阈值 | 11 类上下文集成（git/lsp/spec/memory/session/plugin…） |
| [github/spec-kit](https://github.com/github/spec-kit) | [templates/commands/clarify.md](https://github.com/github/spec-kit/blob/main/templates/commands/clarify.md) | 单文件 19.5 KB 指令文档 | 0（文档；执行时逐问） | **澄清全工艺**：10 类歧义分类法、上限 5 问、Impact×Uncertainty 排序、`Recommended:` 一键接受、"无歧义就明说没有" | 5 问长表单、逐题一轮、答案回写文件 |
| [ClarifyGPT/ClarifyGPT](https://github.com/ClarifyGPT/ClarifyGPT) | [prompt_humaneval.py](https://github.com/ClarifyGPT/ClarifyGPT/blob/main/src/prompt/prompt_humaneval.py)（78 KB）· [prompt_mbpp.py](https://github.com/ClarifyGPT/ClarifyGPT/blob/main/src/prompt/prompt_mbpp.py)（47 KB）· [run_clarify_gpt4_mbpp.py](https://github.com/ClarifyGPT/ClarifyGPT/blob/main/src/clarify/run_clarify_gpt4_mbpp.py) | 提示词文件合 125 KB | ≥4/轮：多份解→一致性判定→生成问题→模拟回答→出最终码 | "歧义 = 两种都能读通的理解"这一定义；`### Clarifying Questions:` 标题式契约 | 用"生成 N 份代码再比对"检测歧义；需可执行测试 |
| [microsoft/PromptWizard](https://github.com/microsoft/PromptWizard) | [critique_n_refine/prompt_pool.yaml](https://github.com/microsoft/PromptWizard/blob/main/promptwizard/glue/promptopt/techniques/critique_n_refine/prompt_pool.yaml) | 单 yaml ≈300 行（含 30+ 条 thinking_styles） | 每步多次：变体+逐样本 solve+评分+critique+refine，多轮 | critique→refine 形状；`Wrap each reason with <START> and <END>` 取块手法 | critique 是**证据驱动**的（"这些样本做错了"），无样本集抄不了 |
| [Eladlev/AutoPrompt](https://github.com/Eladlev/AutoPrompt) | [meta_prompts_generation/step_prompt.prompt](https://github.com/Eladlev/AutoPrompt/blob/main/prompts/meta_prompts_generation/step_prompt.prompt) | 4 套 `meta_prompts_*/` + predictor/annotation 管线 | 数十到数百（默认 `--num_steps 30`）；README 自述"几分钟、< $1" | "隐式假设"的可命名性 | 整套校准流程 |
| [ayagup/genai-patterns](https://github.com/ayagup/genai-patterns) | [langchain/129_clarification.py](https://github.com/ayagup/genai-patterns/blob/main/langchain/129_clarification.py) | 单 py 文件 | 2（检测+提问） | 歧义四分类 + pydantic 字段 | 两段式；`confidence: float` 是噪音 |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | [llm-rubric.md](https://github.com/promptfoo/promptfoo/blob/main/site/docs/configuration/expected-outputs/model-graded/llm-rubric.md) | 文档 | 1/断言（离线，不进运行时） | grader 输出 `{"reason","score","pass"}` + `threshold` + `not-` 取反——**只用于离线测试** | 任何运行时打分 |
| volcengine/PromptPilot | **未验证**：`volcengine` 组织下无公开托管优化器仓库；同名仓库（`doganarif/promptpilot` 78★、`L-AILab/PromptPilot` ICML 论文）均非火山引擎 | — | — | — | — |
| anthropics/skills | **否定结论（已核目录）**：[`skills/`](https://github.com/anthropics/skills) 19 个 skill 中无 prompt-improver；`discernment-nudge` 是判断力提示，非改写器 | — | — | — | — |

> 未通读：`linshenkx` 的 `iterate/iterate.ts`（3.4 KB）**两次抓取网络失败**，只确认路径与体积；ClarifyGPT 两个大文件仅片段检索（引用句可核实）；`129_clarification.py` 全文两次超时，词表与字段经检索片段核实。

## 3. 逐条提炼

**3.1 优化器不是回复者（linshenkx）**——模型看到"帮我写个排序"会自己开始写代码。

> `**优化 ≠ 回复**` / `- 你的任务是**改进选中的消息本身**，不是生成对该消息的回复` / `- 输出必须**保持与原消息相同的角色**`（[context-message-optimize.ts](https://github.com/linshenkx/prompt-optimizer/blob/develop/packages/core/src/services/template/default-templates/optimize/context/context-message-optimize.ts)）

落到我们：现有第 1 条只说"不改变任务目标"，缺"保持说话人角色"。JSON 里加 `intent.role` 可顺带显式化——模型填了角色字段就不易滑成助手口吻。

**3.2 适度优化原则（linshenkx）——压制"补全"的过度扩张。**

> `- **简单消息保持简单** - 不要把一句话变成一篇文章` / `- **风格一致性优先**` / `- **优化幅度要合理** - 原消息已经清晰的部分不要画蛇添足` / `2. **补充必要信息** - 只添加真正缺失的关键信息`

落到我们：`gaps[]` 语义必须是"只补缺口，不改已清楚的部分"。system prompt 加一句：`任何 gap 必须能指出草稿里缺了哪一格，指不出就不是 gap`；`gaps.length` 硬上限 5，Host 截断。

**3.3 genre 关键词分类：一套模板拆五份，且 0 次调用（claude-prompt-improver）。**

> `/** Prompt genre classification` / ` * A cheap keyword heuristic (no API call) that decides which guideline block` / ` * and worked example the improvement template includes`（[prompt-genre.ts](https://github.com/GaZmagik/claude-prompt-improver/blob/main/hooks/src/services/prompt-genre.ts)）

`fix`/`investigate`/`research`/`build`/`general`，正则打分、最高者胜、同分取更独特者。落到我们：**照抄机制，换中文词表，只做三档** `code`（fix/build）/ `knowledge`（research/investigate）/ `general`。两档的完成标准措辞完全不同，恰好是该文件最有价值的两句：

> `6. End non-trivial task prompts by naming how to VERIFY the work: what to run, what to observe, and what evidence to report back`
> `- Demand epistemic discipline: verbatim quotes with source links, findings separated into VERIFIED (actually read from a doc/repo) versus inferred`

`general` 档留空——简单消息不加框架，与 3.2 同一件事。

**3.4 "批评后改写"：只保留形状，不能保留判据（PromptWizard）。**

> `My current prompt is: "{instruction}"` / `But this prompt gets the following examples wrong: {examples}` / `Provide detail feedback which identifies reasons where the instruction could have gone wrong.`

它的批评**只能来自跑错的样本**，我们没有样本集。**结论：单次自检无法捕捉 PromptWizard 的 critique rubric**——模型对自己刚写的东西自我批评没有外部信号锚定。可保留的只有形状："先列缺口再落笔"：JSON 字段序 `intent → gaps → questions → prompt` 天然制造这个先后，**不增加调用次数**。

**3.5 上下文模式：用对话证据代替提问（linshenkx）。** 用户消息把对话逐条 JSON 化，且连空情况都显式建模：

> `{{^conversationMessages}}` / `[该消息是对话中的第一条消息]` / `{{/conversationMessages}}`

落到我们：上下文已有（6 条消息 + 附件清单），第 8/9 条已在做指代消解。要改的是**优先级**：`凡是能从最近对话或附件清单确定的，直接回填 gaps[].assumed 且 source="context"；上下文也确定不了的，才允许进 questions[]`。

**3.6 占位符逐字保留（linshenkx）——本次改造最需要防的回归。**

> `如果原始 prompt 包含双花括号变量占位符（例如 {{variable_name}}），这些是后续运行时变量，必须在优化后的 prompt 中逐字保留，不要改名、删除或替换成具体值。`

现有第 2 条保的是路径/标识符/数字/命令；这里补"占位符类"：`{{var}}`、`{placeholder}`、`<YOUR_NAME>`、`$1`。它们长得像"缺失信息"，**最容易被"补全"误填**。写死一条：`{{...}} / <...> 形式是故意留空，属于"已完整"，不算 gap。`

**3.7 机械 diff 生成"改了什么"（claude-prompt-improver）。** 三档：新增 XML 标签或编号列表 → `Added structure`；新增 `<context>` 等 → `Injected context`；token 增长 >20% → `Expanded with detail`；都没有 → `Enhanced clarity`。全部正则+长度比较，0 次调用。落到我们：我们更便宜——同一次调用里模型已自报 `gaps[]`，不必猜；机械 diff 只留在测试里断言"没把草稿砍掉 50%"。

**3.8 短路：不该优化时不优化（claude-prompt-improver）。** 优先级：分叉会话（防递归）→ 含 `#skip` → 少于 `shortPromptThreshold`(10) token → 上下文余量 <5%。落到我们：第 5 条不适用（辅助调用不吃主上下文）；第 3 条值得抄，`#skip` 是 0 成本的逃生口；第 4 条比"草稿为空禁用"更进一步，**草稿 < 4 字符直接禁用**（`hi` 也不需要优化）。

## 4. 澄清（clarify）设计证据

### 4.1 何时问、何时假设

spec-kit 是唯一把"什么值得问"写成硬条件的：

> `- Only include questions whose answers materially impact architecture, data modeling, task decomposition, test design, UX behavior, operational readiness, or compliance validation.`
> `- Exclude questions already answered, trivial stylistic preferences, or plan-level execution details (unless blocking correctness).`
> `- If more than 5 categories remain unresolved, select the top 5 by (Impact * Uncertainty) heuristic.`

翻成我们的三档判据（直接进 prompt）：

| 情况 | 处理 | 依据 |
| --- | --- | --- |
| 上下文/附件能确定 | 回填，`source:"context"`，**不问** | linshenkx 上下文模式；现有第 8/9 条 |
| 上下文答不出且答案会改变输出内容 | 回填推荐值 + 附 1 问 | spec-kit "materially impact"；ClarifyGPT 两个读法都成立 |
| 纯风格偏好（长/正式） | **不补不问** | linshenkx 适度优化；`PRESERVE the original tone` |

"连问题都不用问"也有正面样本：`- If no meaningful ambiguities found ..., respond: "No critical ambiguities detected worth formal clarification."` → 我们的对应物是 `questions: []`，**空数组是正常返回值，不是失败**。

### 4.2 数量上限

gpt-engineer 的 clarify preprompt 全文三行，`pick one` 是核心：

> `You will read instructions and not carry them out, only seek to clarify them.`
> `Specifically you will first summarise a list of super short bullets of areas that need clarification.`
> `Then you will pick one clarifying question, and wait for an answer from the user.`
> —— [preprompts/qa](https://github.com/ClarifyGPT/ClarifyGPT/blob/main/baseline/gpt-engineer-main/gpt_engineer/preprompts/qa)

spec-kit 的 5 问绑定"一次会话"且明确逐题一轮（`Present EXACTLY ONE question at a time.` / `Never reveal future queued questions in advance.`）；ClarifyGPT 的示例也是单条。

**结论分两种界面，别混用**：
- **单行 chip 条**（复用现有 inline 提示行）：`questions.length ≤ 1`，Host 硬截断。理由：只有一行宽度，第二个问题会把"一键"变成"两步"。
- **面板一次性列出多个问题 + 每问一排 chip**：上限可放到 **3**——约束的本质是**轮数 ≤ 1**（所有问题同屏、点完一次重写），而不是问题总数。spec-kit 强制"一次一个"是为了避免问题墙与上下文漂移，不是数量限制本身。

这条区分很重要：`spec-kit` 的 5、`gpt-engineer` 的 1，两个数字并不矛盾，它们量的是**不同维度**（总预算 / 单次提问数）。

### 4.3 推荐默认值与措辞（可直接抄）

> `**Recommended:** Option [X] - <reasoning>` + 2–5 项表格 + `You can reply with the option letter (e.g., "A"), accept the recommendation by saying "yes" or "recommended", or provide your own short answer.`

措辞质量规则（全篇最有价值的工程细节）：

> `- Lead with **Question:** followed by a full interrogative that ends with ?. The question text before the ? must make sense on its own.`
> `- NEVER use a topic label, section heading, or requirement id as the question itself.`
> `- Immediately after the question line, add one plain-language "Why it matters" sentence ...`
> `- Use everyday wording; introduce jargon only if defined in the same sentence.`

落到我们（一行 chip，高度≈一行中文）：

```
已补全 2 处 · 改哪个文件？(src/app.ts 推荐 / 整个 src/)
```

= `gaps` 计数 + `questions[0].q` + `options[0]`（前缀「推荐」）+ `options[1]`。不要表格、不要 reason 段落——"Why it matters" 压成括号里的半句。

### 4.4 "歧义"的定义与词表（唯一可直接复用的分类）

> `Types of ambiguity:` / `- Lexical: Multiple meanings of a word (e.g., "bank" - financial or river)` / `- Syntactic: Sentence structure unclear (e.g., "I saw the man with the telescope")` / `- Semantic: Vague or imprecise meaning (e.g., "nearby", "soon")` / `- Referential: Unclear what something refers to (e.g., "it", "that thing")`
> `is_ambiguous: bool` / `ambiguity_type: str`（lexical, syntactic, semantic, referential）/ `confidence: float`
> —— [129_clarification.py](https://github.com/ayagup/genai-patterns/blob/main/langchain/129_clarification.py)

我们补第五类 `missing`（缺槽位，不是"读不通"而是"没写"）。理由：草稿最常见的不是歧义，而是"我知道要什么但没写出来"（改哪个文件、给谁看、多长）；ClarifyGPT 的方法针对的也是这一类（"requirements might be ambiguous **or insufficient**"）。它的操作性定义值得抄成一句：

> `Thus, the candidate solutions writtent by these developers have different functionalities, and some of them are wrong.` / `Your task is to clarify this requirement by asking clarifying questions.` / `Specifically, you first analyze how each developer understands the requirement.`

即 **歧义 = 存在两个都能读通、但产物不同的理解**。所以 `gaps[].why` 应写"按 A 理解会得到 X，按 B 理解会得到 Y"，而不是"这条不清楚"——这一句逼出两个读法，也自然生成两颗可点 chip。它的输出契约是标题分节（`### Clarifying Questions:` … `### Answers:` … `### Final Solution:`）；我们改用 JSON，但保留一条经验：**问题与答案分两段，回答阶段不重新提问**。

## 5. 信息补全（assumption）设计证据

**5.1 藏过程，露假设。** fabric 内联了 OpenAI 关于 inner monologue 的原文：

> `The idea of inner monologue is to instruct the model to put parts of the output that are meant to be hidden from the user into a structured format ... Then before presenting the output to the user, the output is parsed and only part of the output is made visible.`

我们的 `[[NOTES_BEGIN]]` 就是同一手法。但**假设不能藏**——AutoPrompt 说得很准：

> `Note that the previous prompt contains an implicit assumptions on the intent of the task that might be incorrect. You should replace this assumption with more accurate assumptions using the score of the previous prompts and the error analysis.`

分界线：推理过程进 NOTES（丢弃）；**每条被填的缺口必须作为结构化数据返回**（`gaps[]`），因为它会改变输出内容。

**5.2 三条落地手段（都不加组件）。**

1. **一行 chip，不是面板。** 借 3.7 的强度：`已补全 2 处 · target_path=src/app.ts · 语言=中文`，chip 上的 `×` = 撤回该条假设。
2. **复用现有渲染位。** 已有"失败 → 旁边一行中文提示，6 秒后消失"（[README](../README.md) 效果表）。把"6 秒后消失"改为"有 questions 时常驻"就得到提问条。现有两槽 `conversation.input.activity`（单槽，按钮）与 `conversation.input.overlay`（列表，骨架屏）已够用。
3. **状态机加一个 phase，不加组件。** 现有 per-session 状态 `{ phase: 'idle'|'pending'|'done', error }`（[client.js](../client.js) 74–79 行）；新增 `phase:'asking'` + `questions` 字段即可，`asking → pending → done` 走原链路，**撤销语义不变**。

**5.3 证据等级压到 3 档，不要百分比。** `confidence: float` 不建议照抄：浮点置信度在 UI 上无法消费（用户不知道 0.63 该干嘛），还诱使我们做阈值逻辑。压成 `source: "context"|"default"|"guess"`——它同时回答"可不可信"和"为什么可信"，UI 只需决定要不要给 chip 加「?」后缀。

## 6. 反模式清单（看起来厉害，违背小而美）

| 反模式 | 出处 | 为什么不能要 |
| --- | --- | --- |
| 整篇提示词工程教程内联进 system prompt | fabric `improve_prompt`（万词级） | 每次点击都按它计费；现有 SYSTEM_PROMPT ≈1.5 KB，扩到 3 KB 已是上限 |
| 模板库 + 模式选择器（基础/进阶/上下文/图像 × 系统/用户） | linshenkx `default-templates/` 11 族 | 一个按钮变下拉 + 选择页；点 ✦ 的期望是"别让我选" |
| 多候选版本（长版/短版/方案二）+ 推荐 | 反面样本 `ricardorqr/improve-prompt-plugin`；linshenkx 反而把"更短的版本/方案二"列入**禁止** | 输入框只能放一版，放两版就要新增"选哪版"UI；现有第 6 条"只给一个版本"是对的，**保持** |
| 运行时 rubric 打分（0–1 分 + threshold） | promptfoo `llm-rubric` | 用户要提示词不要分数；分数还引出"为什么只有 0.7"。**只用于离线测试** |
| eval 驱动 critique（拿跑错样本喂批评） | PromptWizard | 需数据集与"正确答案"，我们没有 |
| 合成边界样本 + 标注 + 数十轮校准 | AutoPrompt（`num_steps 30`，分钟级，$1） | 单次点击延迟预算 60s（现有 `CALL_TIMEOUT_MS`），且无标注数据 |
| 生成 N 份解做一致性检查判歧义 | ClarifyGPT | 4+ 次调用、需可执行测试；判的是"代码是否唯一"，不是"提示词是否清晰" |
| 5 问逐题表单 + 答案回写文档 | spec-kit `clarify` | 长流程 spec 工具；我们是输入框旁的一次性动作 |
| 30+ 条 thinking_styles 常量表 | PromptWizard `prompt_pool.yaml` | 纯 token 噪音 |
| 让模型把"假设"写进正文（`假设：…`） | 常见做法 | 会漏进 draft——信封只保护"块外的说明"，保不了"块内正文"。假设必须是独立字段 |

## 7. 建议的最小架构

### 7.1 调用次数：1 次常驻 + 0/1 次按需

```
点击 ✦
 └─ 调用 A（唯一常驻）：draft + 上下文 + 附件 → { intent, gaps, questions, prompt }
     ├─ questions == []  → 直接写 draft，按钮变 ↺            （绝大多数情况，延迟 = 现在）
     └─ questions == [1] → 写 draft（已是按推荐值补齐的成品），同一行显示 1 问 + 2 颗 chip
                             ├─ 点 chip → 调用 B（带 answers）→ 覆盖 draft
                             └─ 不点    → 什么都不发生（成品已在框里）
```

**为什么不做"2 次常驻（先问再写）"**：① claude-prompt-improver 跑在提交路径上，边界第一条就是 `DO NOT ask questions or request clarification`——成熟的输入路径插件把不阻塞当硬约束；② linshenkx 上下文模式宁可"补充必要信息"也不问，说明"少问"是产品级选择；③ 入口是一次点击，先问必然多一跳，而**这一跳在最常见的草稿上毫无收益**（简单草稿没有值得问的缺口）。

**为什么也不做"纯 1 次、永不提问"**：那等于把用户真实缺口藏进不可见假设。AutoPrompt 已证明"隐式假设"是提示词失败主因之一；spec-kit 证明"带推荐值的一问"成本可以低到一行字。取中间：**问题永远可选、永远有默认答案、永远只有一个**。

### 7.2 建议输出 schema（一次返回四组字段）

```jsonc
{
  "lang": "zh",                          // 输出语言，跟随草稿
  "genre": "code | knowledge | general", // 中文关键词判定（0 次调用），决定完成标准措辞
  "intent": { "goal": "一句话：用户到底要什么", "deliverable": "期望产物形态", "audience": "给谁看（可省略）" },
  "gaps": [                              // 硬上限 5；每条必须能说出"缺了哪一格"
    { "type": "missing | lexical | syntactic | semantic | referential",
      "slot": "target_path",
      "why": "按 A 读是 X，按 B 读是 Y",   // 或"草稿没说改哪个文件"
      "assumed": "src/app.ts",            // 已回填值；进 prompt 的就是它
      "source": "context | default | guess" }
  ],
  "questions": [                          // 硬上限：单行 chip 条 1 / 面板 3；空数组是正常结果
    { "q": "改哪个文件？",                 // 完整疑问句、以问号结尾、脱离上下文能读懂
      "options": ["src/app.ts（最近对话里提到的那个）", "整个 src/ 目录"] }  // options[0] = 推荐项
  ],
  "prompt": "……最终提示词正文（纯文本，真换行，无围栏）……",
  "notes": "……改动说明，Host 整块丢弃……"
}
```

Host 侧四条硬规则（不靠模型自觉）：① `questions` 超上限 → 截断（保留靠前的，因为 prompt 要求按影响排序）；② `gaps.length > 5` → 截断；③ `gaps[i].assumed` 为空 → 不产生副作用（不允许"知道缺了但没补"的死条目）；④ `prompt` 为空或全是元信息 → 沿用现有失败分支，**绝不把 notes 当 prompt**。

**JSON 还是行前缀块？我倾向 JSON，但这条证据不强，取舍如下（供裁决）：**

| | JSON（本报告建议） | 行前缀块（`[[PLAN_BEGIN]]` + `TYPE:`/`ASSUME:`/`ASK:`） |
| --- | --- | --- |
| 嵌套与数组 | 天然支持 `options: []` | 靠 `\|` 分隔，**内容里出现 `\|`（中文表格很常见）就歧义** |
| 部分失败 | 一处语法错 → 整块报废（all-or-nothing） | 坏一行丢一行，其余照用——**对模型偷懒更鲁棒** |
| 现有基础设施 | `extractJsonPrompt` / `salvagePromptField` 已存在，可直接复用 | 需要新写 `parsePlan()` |
| 与正文信封的类比 | 两套解析器 | 与 `[[PROMPT_BEGIN]]` 同构，一套心智模型 |

行前缀块在"降级不失败"这一条上确实更强（design-v2 的"坏行丢弃"就是这个优点）。若采用它，**必须解决 `|` 分隔符**：改成 `ASK: 改哪个文件？ => client.js ;; optimize.js` 或用行内 JSON 数组，否则选项里带竖线时静默丢项。

### 7.3 与现有实现的差量

| 位置 | 改动 | 新增组件 |
| --- | --- | --- |
| `optimize.js` SYSTEM_PROMPT | 加"缺口分类 / 假设优先 / 最多一问 / 占位符不算 gap"；删掉第 10 条"不要向用户提问"那半句 | 否 |
| `optimize.js` `sanitizeOutput` | 先 JSON，再现有 `ENVELOPE_BEGIN` 提取，再纯文本 | 否 |
| `optimize.js` 响应体 | 增加 `gaps` / `questions` / `intent`（向后兼容） | 否 |
| `client.js` store | `phase` 增 `'asking'`；条目增 `questions` | 否 |
| `client.js` 渲染 | 复用现有 inline 提示行（或 `conversation.input.dock` 面板）；`questions` 非空时显示 chip 行，`×` 撤销单条假设 | 否（复用现有行/槽位） |
| `client.js` 交互 | 点 chip → 再次 POST（带 `answers`），同一条 `optimize` 路由 | 否（同接口加可选字段） |
| `docs/protocol.md` | 记录新字段与降级顺序 | 否 |

**唯一真正新增的东西：一个 JSON 字段和一颗 chip。**

### 7.4 建议进 `test/host.optimize.mjs` 的断言

① `questions` 两条 → 只留一条；`gaps` 六条 → 只留五条。② 模型返回纯 marker 旧格式 → 仍能提取，`gaps`/`questions` 为空数组，UI 行为与今天完全一致。③ 返回 `{"prompt":"…"}` 无 `gaps` → 不报错，`gaps: []`。④ 草稿里的 `{{var}}` 必须逐字出现在结果里（防误填占位符）。⑤ `questions: []` 路径下**不得**出现任何新的 UI 元素（否则"绝大多数情况无感"这条设计就破了）。

## 附：本次未能验证的项

- `linshenkx` 的 `iterate/iterate.ts`（3.4 KB）：两次抓取网络失败，内容 **未验证**。
- `ClarifyGPT` 两个大提示词文件（78 KB / 47 KB）：仅片段检索，完整 prompt 未通读（引用句可核实）。
- `volcengine/PromptPilot`：`volcengine` 组织下**无**公开托管优化器仓库，存在性 **未验证**。
- `anthropics/skills`：无 prompt-improver 相关 skill（否定结论已核目录）。
- `129_clarification.py`：全文两次超时，词表与 pydantic 字段经检索片段核实。
