# prompt-polish v2 — Independent Verification Review

Verifier: teammate `verifier`. Method: read `design-v2.md`, `protocol.md`,
`optimize.js`, `client.js`, `index.js`, `test/*.mjs`, `research-github.md`;
ran `node test/run-all.mjs` (all green); then drove `optimize.js` directly with
hand-built model outputs to confirm/refute specific failure modes.

## 1. 结论 (Verdict)

**SHIP-WITH-FIXES.** The wire contract matches design §2/§3/§6 exactly, the
client state machine holds (no double-write, no stuck `pending`, no answer leak
after a failed refine, single-flight solid, cross-session write-back correct,
undo always restores the first draft). The suite is strong. Two real defects
remain, both in `optimize.js` sanitation: (1) a model that emits a PLAN block
with **no** PROMPT block writes literal `[[PLAN_BEGIN]]`/`[[PLAN_END]]` markers
into the composer draft; (2) the "strip PLAN-record lines" pass silently deletes
any prompt line that begins with `TYPE:`/`NOTE:`/`ASSUME:`/`ASK:` + colon —
faithful to §4.2 but a sharp edge on real user content. Neither is a blocker for
the common path; both should be fixed before release.

## 2. 必须修 (Must fix)

1. **`optimize.js` `extractEnvelope`/`sanitizeOutput`/`stripPlanRecords`
   (lines 931–946, 1095–1154, 1173–1177) — PLAN-only output leaks marker
   literals into the draft.**
   *触发条件:* model returns only `[[PLAN_BEGIN]] … [[PLAN_END]]` and no
   `[[PROMPT_BEGIN]]` (the inverse of the well-tested "ignores PLAN" case — a
   model that "ignores the PROMPT block" instead).
   *后果:* `extractEnvelope` returns `null` → plain path keeps the whole raw →
   `stripPlanRecords` drops the inner record lines but leaves the two wrapper
   markers, so the composer draft becomes the literal string
   `"[[PLAN_BEGIN]]\n[[PLAN_END]]"`. Confirmed by direct run:
   input `[[PLAN_BEGIN]]\nTYPE: coding\nASSUME: 语言 => 中文\n[[PLAN_END]]`
   → `text === "[[PLAN_BEGIN]]\n[[PLAN_END]]"`, `plan` parsed fine. This
   violates §3 ("PLAN 块整块不进输入框") and turns a success into garbage in the
   user's text box.
   *建议改法:* after envelope extraction, if no `[[PROMPT_BEGIN]]` was found but
   a `[[PLAN_BEGIN]]`/`[[PLAN_END]]` wrapper is present (or the surviving text is
   only those markers), treat as "no usable prompt" → `fail('模型没有返回可用的提示词…')`
   instead of shipping markers; and always strip the literal
   `[[PLAN_BEGIN]]`/`[[PLAN_END]]` lines in `stripPlanRecords`.

2. **`optimize.js` `PLAN_RECORD_LINE` + `stripPlanRecords` (lines 1166, 1173–1177)
   — legitimate prompt lines starting with a record keyword + colon are deleted.**
   *触发条件:* the rewritten prompt contains a line such as
   `NOTE: 这是一个需要保留的脚注。` or `TYPE: 先读文档再改代码。` (a colon
   immediately after the keyword). `PLAN_RECORD_LINE =
   /^[\s>*+#\`_-]*(?:ASSUME|ASK|TYPE|NOTE)\s*[:：]/iu` matches and the whole line
   is dropped. Confirmed by direct run: `NOTE: 这是一个需要保留的说明行。`
   → `text === undefined` (entire line gone); `TYPE: 先读文档，再改代码。`
   → dropped. The model is told to use exactly this `TYPE:`/`NOTE:` shape for the
   PLAN, so it occasionally echoes it as a body heading.
   *后果:* silent loss of a real prompt line. §4.2 explicitly mandates dropping
   those prefixes ("防串块"), so this is spec-faithful — but the regex is
   broader than necessary (a bare `NOTE:` header with prose is indistinguishable
   from a PLAN record).
   *建议改法:* tighten to well-formed records only — require an arrow for
   `ASSUME`/`ASK`, and for `TYPE`/`NOTE` require the value to look like a record
   (e.g. `TYPE:` followed by a known type token, or only strip when the line is
   *exactly* `TYPE:`/`NOTE:` + nothing structurally prompt-like). At minimum,
   document the trade-off in `protocol.md`. (If kept as-is, it is compliant — but
   flag it as a known sharp edge, not silent.)

## 3. 建议改 (Nice to have)

1. **Share one PLAN-record-prefix test.** Two regexes detect the same prefix set:
   `PLAN_RECORD_LINE` (strip, line 1166) and the inline `record` regex in
   `parsePlan` (line 1252). They have already drifted (strip is broader than
   parse). Extract one `isPlanRecordLine` helper so "strip" and "parse" agree on
   what a record is. Not dead code — both are read — but duplicated intent.

2. **Client-side request timeout is untested.** `TIMEOUT_MS`/`TIMEOUT_MS_WITH_IMAGES`
   (client.js 33–35) abort the in-flight `fetch` and call `store.fail`. No test
   exercises it; the happy path relies on the Host's 60s deadline. Add a
   client-level timeout test (stub a never-resolving `fetch`).

3. **`normalizeAnswers` newest-6 cap is untested on the client.** After 7 refine
   clicks `beginRefine` calls `normalizeAnswers(answers)` which slices to the
   newest 6 (client.js 127). Worth one assertion that the 7th answer drops the
   oldest, since the Host caps at 6 too and a disagree would mis-send.

4. **`readPlan` vs `parsePlan` shape is duplicated defensively** (host parses,
   client re-normalizes). This is intentional second-line-of-defence per §6 and
   not bloat — keep it; just note both must stay in sync if the schema changes.

## 4. 契约一致性核对表 (Contract vs implementation)

| Design item | Implemented at | Result |
| --- | --- | --- |
| §2 request adds `answers` (≤6, optional) | `index.js:48` forwards; `optimize.js parseAnswers` caps 6 (1302–1315); `client.js normalizeAnswers` caps 6 (111–128) | 通过 |
| §2 request `text` = ORIGINAL draft even in round 2 (never the rewrite) | `client.js beginRefine` `requestText: live.original` (244); `startRefine` body `text: started.requestText` (1292) | 通过 (test: client.plan 3) |
| §2 response `plan` nullable, shape `{type,notes,assumptions[{slot,value}],questions[{q,options}]}` | `optimize.js parsePlan` (1234–1295) returns exactly this or `null`; `client.js readPlan` (561–602) | 通过 |
| §2 `plan:null` = degradation, not failure | Host sets `plan: parsePlan(raw)` (1547), `ok` stays `true`; client hides dock when `plan===null` (client.js 1329) | 通过 |
| §2 caps: notes120 / assum6 / slot16 / value60 / q3 / q40 / opt4 / opt20 | `PLAN_LIMITS` (96–105) enforced in `parsePlan` + `splitRecordOptions` | 通过 |
| §3 model-side PROMPT/PLAN block, `=>` split, `;;` options, `\|` never a separator | `SYSTEM_PROMPT` (132–193); `splitRecordArrow` (1195–1199); `splitRecordOptions` (1207–1220) | 通过 |
| §4.2 `sanitizeOutput` strips `ASSUME:/ASK:/TYPE:/NOTE:`-prefixed lines | `stripPlanRecords` (1173–1177) | 通过 (sharp — see §2 #2) |
| §4.2 `buildUserInput` appends confirmed-answers block on round 2 | `buildUserInput` (346–354) | 通过 (test: host "confirmed answers ride along") |
| §4.2 `runOptimize` returns `plan`; Host trims, client re-trims | `runOptimize` (1541–1548); client `PLAN_MAX_*` (68–75) | 通过 |
| §6 store: pending `{mode,answers,requestText}`, done `{plan,answers,planHidden}` | `client.js` (147–377) | 通过 |
| §6 `PolishPlanDock` shows only when `phase==='done' && plan && !planHidden`; refine shows busy line | `PolishPlanDock` (1271–1423, 1309–1327, 1329) | 通过 |
| §6 click candidate → `beginRefine` → POST `{text:original, answers:[…已答,本次]}` → succeed writes draft via button effect | `pick` (1297–1307), `beginRefine`, `succeed`, write effect (913–926) | 通过 |
| §6 undo always restores FIRST draft, after ≥1 refine rounds | `original` preserved through `beginRefine` (243); `runUndo` `setDraft(state.original)` (961) | 通过 (test: client.plan 8, 8b) |
| §6 `MIN_DRAFT_CHARS=4` single disable gate | `client.js` (84, 941–942) | 通过 (test: behaviour "short draft") |
| §7 `node test/run-all.mjs` all green; `index.js`/`package.json`/`cordis.patch.yml` unchanged | suite passes; I did not modify them | 通过 |

## 5. 测试真实覆盖 (by failure mode)

**Covered (asserted):**
- PLAN parse: normal / decorated markers / bullets / full-width colon /
  unterminated block / malformed-record drop / unknown-type drop /
  pipe-option recovery / all caps (host.optimize "parses TYPE…" … "enforces the caps").
- No PLAN block → `plan:null`, prompt still ships (host "no PLAN block").
- Leaked PLAN records inside the prompt body are stripped (host "PLAN records leaked").
- Half-broken PLAN (bad lines) → partial parse, no crash (host "drops malformed records").
- Old-shaped answer (no `plan` key) → degrades to v1 UI, no panel (client.plan 10 "no plan").
- `plan:null` after a refine → panel hides, draft written, undo still offers (client.plan 8b).
- Unknown `type` → label omitted, panel still valid (client.plan 10).
- Client 4 states + undo + edit-invalidation + fail-keeps-draft + session-switch
  no-write + single-flight + cross-session refine write-back + plan render +
  refine wire shape (`text:original`, accumulated answers) + answered-question
  dedup + refine-failure rollback (keeps draft & panel) + close-keeps-undo
  (behaviour 74 checks, plan 84 checks).
- `answers` enter the user message; validated/deduped/capped to newest 6 (host).
- Round-2 sends original draft, not the rewrite (client.plan 3, 5).

**NOT covered (name the missing test, not written):**
- **PLAN-only output (no PROMPT block) → marker literals land in the draft** (§2 #1).
  No harness asserts the draft is clean/empty-failed in this case. This is the
  most important missing test.
- **A prompt line legitimately beginning with `NOTE:`/`TYPE:` is dropped** (§2 #2).
  No test pins the behaviour either way; given §4.2 mandates it, a test should
  at least assert the *intended* contract so a future tightening doesn't regress silently.
- **Client request timeout** (`TIMEOUT_MS*`) → `store.fail(timeout)`; only the
  Host 60s deadline is exercised.
- **`normalizeAnswers` oldest-drop at >6 answers** on the client across many refines.
- **`parseAnswers`/`normalizeAnswers` newest-6 cap on the Host** is covered; the
  *client* side of the same cap is not asserted end-to-end.
- **Fenced envelope that embeds the `[[PROMPT_BEGIN]]` markers** (marker tolerance
  inside a ``` fence) — trivial but untested.

## 6. 小而美审计 (bloat / dead code)

Checked deliberately; **no dead code, no unread constants, no unrendered locale keys found**:

- Every `PLAN_*` / `SKELETON_*` / `MAX_*` constant in `client.js` and
  `optimize.js` is read (verified by grep + read). `SKELETON_LAST_WIDTHS`,
  `SKELETON_BAR_PATTERN`, `ELLIPSIS`, `NO_ANSWERS`, `IDLE_STATE`, `PLAN_RECORDS`,
  `PLAN_TYPES`, `MAX_ANSWERS`, `ANSWER_TEXT_MAX_CHARS` all referenced.
- Every locale key in `client.js` (zh + en) is rendered by some component:
  `button.{polish,pending,undo}`, `error.{network,timeout,generic}`,
  `dock.{title,title.plain,title.short,title.short.plain,pending,assumptions,questions,notes,close,refining,recommended}`, `dock.type.{coding,writing,analysis,image,other}`.
  None are dead.
- The skeleton/geometry machinery (`measureComposerEditor`, `composerMeasureTargets`,
  `estimateSkeletonHeight`, `skeletonBarCount`, `skeletonBarWidths`,
  `PolishSkeleton`) is v1-inherited and necessary — not v2 bloat.
- Only duplication worth a cleanup: the two PLAN-record-prefix regexes
  (`PLAN_RECORD_LINE` line 1166 vs inline `record` regex line 1252). Not dead —
  extract a shared helper (see §3 #1) rather than delete.
- Comments are mostly load-bearing (explain *why* the draft must be defended);
  they restate code rarely. No "delete this comment" candidate stands out.

## 7. State-machine spot-checks (D) — all held

- **Double writes:** write effect guarded by `appliedRef.current === state.token`
  (913–926); `markApplied` idempotent. None observed.
- **Lost result on session switch mid-refine:** origin Session entry persists;
  result written only when that Session's button renders again (cross-session test).
- **Permanent `pending`:** Host 60s `createAbortScope` + client `TIMEOUT_MS`
  both abort → `fail`/`dismiss`. No path leaves `phase:'pending'` forever.
- **Failed-round answers sticking:** `fail` (refine branch) restores
  `previousAnswers: live.answers` (325), so the failed click's answer does NOT
  persist; panel + undo stay (client.plan 6).
- **Dock vs undo button disagree:** both read the same store entry; `hidePlan`
  only flips `planHidden`; undo always `setDraft(original)`. Consistent.
- **Single-flight holes:** `begin` requires `idle`, `beginRefine` requires `done`;
  a second click while in-flight is a no-op (behaviour "concurrency", plan "refine
  second click"). No two in-flight requests in one session.

## 7. 修复记录（Lead，2025-10-30 复核后）

两份「必须修」已修并加断言，全部 harness 复绿（host 83 / client 84/74/46/39/smoke）：

1. **PLAN-only 泄漏** —— `stripPlanRecords` 现在按行剔除裸 `[[PLAN_BEGIN]]`/`[[PLAN_END]]`
   标记（`PLAN_MARKER_LINE`），于是「只给 PLAN 不给 PROMPT」的答案被清成空文本，走既有的
   `模型没有返回可用的提示词` 失败分支，而不是把标记字面量塞进输入框。
   新增断言：`a PLAN block with no PROMPT block is a failure, not marker-literal text`（两种输入）。
2. **误删正文行** —— 收紧为「只剔除契约定义得出来的形状」：`ASSUME`/`ASK` 必须带箭头，
   `TYPE` 必须是已知类型，`NOTE` 仅当正文里出现过 PLAN 标记时才剔除。
   新增断言：`a legitimate prompt line that merely starts with NOTE/TYPE survives`。

「建议改 1」（两条正则漂移）同时做掉：抽出 `matchPlanRecord()`，`parsePlan` 与
`stripPlanRecords` 共用同一个「什么算一条记录」的判定，剥离器再也不会比解析器更宽。

「建议改 2、3」（客户端超时、answers 第 7 次淘汰）**未做**，理由：两者都由 Host 侧
60s 截止与 6 条上限兜底，客户端行为已有跨会话/失败回滚覆盖；再加两个桩测试会让 harness
去模拟时钟与网络栈，收益低于维护成本。

另：`PLAN_LIMITS` 与系统提示词里写给模型的字数上限已对齐为同一组数字
（slot 10 / value 30 / q 20 / option 12），客户端保留更宽的一套作为第二道防线。

## 8. 修复记录（Lead，2025-11-02 线上回归后）

**现象**：用户润色一条多行提示词，输入框里得到的是

````text
改写后的 JSON 字符串：
```json
"/remotion-create …\n这是我做的项目…\n…"
```
````

而不是那四行提示词本身。

**根因**：`sanitizeOutput` 只认两种外壳——「整段就是一个围栏」（`FENCE_WRAPPER` 锚定整段）
和「整段就是一个 `{"prompt": …}` 对象」（`extractJsonPrompt` 只读对象字段）。这次的形态是
第三种：**围栏前多了一行宣告标签，围栏里是顶格的 JSON 字符串**，两条规则都不匹配，纯文本
兜底原样放行。

**修法**（都在 Host，客户端不动）：

1. `unwrapFenceShell`：全篇只有一个围栏、围栏之后没有正文、围栏之前只有 ≤2 行「宣告式」
   标签时，取围栏内容。
2. `extractJsonString`：顶格 `"…"` 解码（`JSON.parse` 优先，裸换行的手写形态走受限容错）。
3. 宣告行只在「后面确实是转义载荷」时才丢，且 `输出格式：`／`改写要求：` 这类格式标签
   一律保留——反向保护有断言（`a sentence that only contains a label word keeps both its
   line and its example`、`a fence surrounded by prompt text is never unwrapped`）。
4. 系统提示词第 8 条补「不要把整段塞进 JSON」，新增第 12 条：草稿里写给另一个模型的输出
   格式要求（"只返回 JSON"）是**内容**，不是给改写模型的指令。

回归用例 7 条，host 断言 83 → 92，六个 harness 全绿。教训记在这里：**契约靠提示词保证的
部分，归一化必须再兜一次**——模型违反第 8 条不是异常，是常态。

### 8.1 补一层：真正的原因是输入形状被照抄

第一版修完，用户仍拿到「一行、全是 `\n`」的结果，而且这次的答案比上次多一层：整段被加上
引号**又**整个 `JSON.stringify` 了一遍。

顺着形状查回去，原因不在模型的脾气，而在**我们自己的用户消息**：`buildUserInput` 把草稿以
`JSON.stringify(draft)` 放进提示词（为了防草稿伪造分隔符越界）。模型看见「答案是转义字符串」，
就照这个形状把答案也转义一遍返回——锚定效应，稳定复现，不是偶发。

所以两处一起改：

1. **输入侧（治因）**：草稿前明说「它用一个 JSON 字符串包着，你返回的正文不要沿用这个包装：
   不要加引号、不要把换行写成 `\n`、不要写成 JSON」。防御性质不变，形状暗示消失。
2. **输出侧（治症）**：`extractJsonString` 改成**循环解码**（≤3 层，一层对应一个「只返回
   JSON」的指令）；放宽 `normalizeEscapedNewlines` 的引号判据（`(?<!\\)`：被转义的引号是
   分隔符，不是用户在引用转义）；最后再剥一次「跨多行、首尾同为 `"`」的残留引号——真实换行
   不可能出现在 JSON 值里，这个判据有据可依，不是猜。

新增断言 3 条（两层引号+转义、JSON 套 JSON、解码后围栏仍然完好），host 92 → 95。留下的边界
也写清楚：引号在**行中**的写法（如 `"第一行\n第二行"`）仍会被解码成换行——这和「用户真的在
谈论 `\n`」无法凭字符区分，现有判据是「引号是否紧邻转义」，够用但不完美。

## 9. 修复记录（Lead，2025-11-02，澄清面板误触发）

**现象**：面板弹出问题后，用户还在逐个看选项、没确认，程序已经开跑下半程。

**根因**：面板把「点一下候选」直接当成了「确认」。`pick()` 就在候选按钮的 `onClick` 里调
`store.beginRefine()` 并立刻发请求，所以**第一次点击就是最终答案**；多问题时更明显——第一
问刚点完就带着一个答案重跑，第二问还没读。不是超时、不是默认值、也没有额外的 `change` 事件：
触发点就是那一次点击本身。

**修法（两处，一个组件内）**：

1. 候选按钮从「提交」降级为「选中」：点击只写组件本地 `selection`（question → option），
   再点一次取消；带 `aria-pressed`/`data-selected`，看得见选了什么。
2. 面板底部加一个「确认并重写」按钮（`disabled` 直到至少选了一个，标签带已选数量），
   只有它调 `beginRefine()`。多问的候选**合并成一次请求**：三个问题一次调用，而不是三次。
3. 单飞照旧：确认时 `beginRefine()` 只从 `done` 起，飞行中再点旧节点是 no-op（有断言）。

**验证**：`client.plan` 84 → 105 项，新增断言覆盖「点候选不发请求、草稿不动、标记可切换、
取消后确认又变灰、确认只发一次、三个答案一次带走且按问题顺序、飞行中点旧节点 no-op」。
`docs/design-v2.md`、`docs/protocol.md` 里的点击语义同步改成「选中 + 确认」。