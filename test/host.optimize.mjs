// Offline test harness for optimize.js.
// Uses hand-made fakes only: no Harness, no network, no live server.
import assert from 'node:assert/strict'

const MODULE_URL = new URL('../optimize.js', import.meta.url).href
const { optimizePrompt } = await import(MODULE_URL)

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}: ${error && error.message}`)
  }
}

/** A fake session whose derived history includes noise that must be dropped. */
function makeSession({ header = { config: { provider: 'deepseek', model: 'deepseek-v4.1-flash', maxTokens: 8192 } }, messages } = {}) {
  const derived = messages ?? [
    { role: 'user', content: [{ type: 'text', text: '请帮我看看 D:\\deepseek\\plugins 下的插件' }], source: { kind: 'user' }, id: 'm1' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'THINKING-SHOULD-BE-DROPPED' }, { type: 'text', text: '好的，我看到了 prompt-polish 插件。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { kind: 'model', provider: 'deepseek', model: 'x' }, id: 'm2' },
    { role: 'tool', content: [{ type: 'text', text: 'TOOL-RESULT-SHOULD-BE-DROPPED' }], source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', id: 'm3' },
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM-SHOULD-BE-DROPPED' }], source: { kind: 'system-prompt' }, id: 'm4' },
    { role: 'user', content: [{ type: 'text', text: '这个优化按钮怎么实现比较好？' }], source: { kind: 'user' }, id: 'm5' },
  ]
  return {
    id: 'session-7',
    requestHeader: () => header,
    deriveMessages: () => derived,
  }
}

/** A fake PreparedLlmCall that streams the given chunks and records what it was given. */
function makeLlm({ chunks, onPrepare, modalities } = {}) {
  const captured = { prepareArgs: [], options: [], dispatches: 0 }
  return {
    captured,
    prepareCall: async (config, signal) => {
      captured.prepareArgs.push(config)
      if (onPrepare) await onPrepare(config, signal)
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      return {
        // Mirrors the real shape: the resolved config INCLUDING a materialized adapter default
        // (maxTokens) that the caller must spread verbatim into the dispatch options, and the
        // resolved reasoning effort the adapter would report back (`resolveCallWithInfo`).
        config: {
          provider: config.provider,
          model: config.model,
          maxTokens: config.maxTokens ?? 8192,
          temperature: 0.3,
          ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
        },
        // `PreparedLlmCall.inputModalities` is optional; its absence means text-only.
        ...modalities === undefined ? {} : { inputModalities: modalities },
        stream: (options) => {
          captured.dispatches += 1
          captured.options.push(options)
          return (async function* () {
            for (const chunk of chunks) {
              if (options.signal && options.signal.aborted) {
                throw Object.assign(new Error('aborted'), { name: 'AbortError' })
              }
              yield chunk
            }
          })()
        },
      }
    },
  }
}

const HAPPY = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hi' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
  { type: 'finish', reason: { kind: 'stop' } },
]

console.log('optimizePrompt offline checks')

// 1. happy path: text assembled, exact route reported, one dispatch
await test('happy path returns {ok:true,text,model} and dispatches once', async () => {
  const session = makeSession()
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt({ sessions: { get: () => session }, llm }, { sessionId: 'session-7', text: '帮我改一下这个按钮' })
  assert.deepEqual(result, { ok: true, text: 'hi', model: 'deepseek-v4.1-flash', route: 'request-header', format: 'plain' })
  assert.equal(llm.captured.dispatches, 1, 'exactly one dispatch')
  assert.deepEqual(llm.captured.prepareArgs[0], { provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  const options = llm.captured.options[0]
  assert.equal(options.provider, 'deepseek')
  assert.equal(options.model, 'deepseek-v4.1-flash')
  assert.equal(options.maxTokens, 8192, 'spreads the materialized adapter default verbatim')
  assert.equal(options.temperature, 0.3, 'adapter default retained')
  assert.equal(options.sessionId, 'session-7')
  assert.equal(options.purpose, undefined, 'must not pass purpose')
  assert.equal(typeof options.system, 'string')
  assert.ok(options.system.includes('[[PROMPT_BEGIN]]'), 'the answer form is spelled out')
  assert.ok(options.system.includes('[[NOTES_BEGIN]]'), 'commentary has a sanctioned place')
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  assert.equal(options.messages[0].id, undefined, 'transient RequestUserInput has no id')
  assert.equal(options.messages[0].source, undefined, 'transient RequestUserInput has no source')
})

// 2. context digest: user/assistant text only, labelled, oldest-first, JSON-framed
await test('context digest keeps only user/assistant text blocks, oldest-first', async () => {
  const session = makeSession()
  const llm = makeLlm({ chunks: HAPPY })
  await optimizePrompt({ sessions: { get: () => session }, llm }, { sessionId: 'session-7', text: '把这个改成生产代码' })
  const input = llm.captured.options[0].messages[0].content[0].text
  assert.ok(input.includes('D:\\\\deepseek\\\\plugins'), 'earlier user text present (JSON-escaped)')
  assert.ok(input.includes('prompt-polish 插件'), 'assistant text present')
  assert.ok(input.includes('这个优化按钮怎么实现比较好'), 'latest user text present')
  assert.ok(input.includes('"speaker":"用户"') && input.includes('"speaker":"助手"'), 'entries are labelled')
  assert.ok(!input.includes('THINKING-SHOULD-BE-DROPPED'), 'reasoning block dropped')
  assert.ok(!input.includes('TOOL-RESULT-SHOULD-BE-DROPPED'), 'tool result dropped')
  assert.ok(!input.includes('SYSTEM-SHOULD-BE-DROPPED'), 'system message dropped')
  assert.ok(!input.includes('"type":"tool-call"'), 'tool call dropped')
  assert.ok(input.indexOf('请帮我看看') < input.indexOf('这个优化按钮'), 'oldest-first ordering')
  assert.ok(input.trimEnd().endsWith('"把这个改成生产代码"'), 'draft framed last as a JSON string')
})

// 3. digest bounds: 6 messages, 1500 per message, 6000 total
await test('digest is bounded to 6 messages / 1500 per message / 6000 total', async () => {
  const messages = []
  for (let i = 0; i < 20; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `MSG-${i}-` + 'x'.repeat(2000) }] })
  }
  const llm = makeLlm({ chunks: HAPPY })
  await optimizePrompt({ sessions: { get: () => makeSession({ messages }) }, llm }, { sessionId: 's', text: 'draft' })
  const input = llm.captured.options[0].messages[0].content[0].text
  const jsonLine = input.split('\n').find((line) => line.startsWith('['))
  const entries = JSON.parse(jsonLine)
  // 6 x 1500 = 9000 > the 6000 total budget, so fewer entries must survive; the cap is what matters.
  assert.ok(entries.length >= 1 && entries.length <= 6, `at most 6 entries (got ${entries.length})`)
  for (const entry of entries) assert.ok(entry.text.length <= 1500, `entry clipped to 1500 (got ${entry.text.length})`)
  const total = entries.reduce((sum, entry) => sum + entry.text.length, 0)
  assert.ok(total <= 6000, `digest within 6000 (got ${total})`)
  assert.ok(entries[entries.length - 1].text.startsWith('MSG-19-'), 'newest kept first under budget')
})

// 4. no derived history -> still works, digest section omitted
await test('short history keeps exactly the last 6 messages', async () => {
  const messages = []
  for (let i = 0; i < 10; i += 1) {
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `SHORT-${i}` }] })
  }
  const llm = makeLlm({ chunks: HAPPY })
  await optimizePrompt({ sessions: { get: () => makeSession({ messages }) }, llm }, { sessionId: 's', text: 'draft' })
  const input = llm.captured.options[0].messages[0].content[0].text
  const entries = JSON.parse(input.split('\n').find((line) => line.startsWith('[')))
  assert.equal(entries.length, 6, 'exactly the last 6')
  assert.equal(entries[0].text, 'SHORT-4')
  assert.equal(entries[5].text, 'SHORT-9')
})
await test('empty history omits the digest section', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt({ sessions: { get: () => makeSession({ messages: [] }) }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, true)
  const input = llm.captured.options[0].messages[0].content[0].text
  assert.ok(!input.includes('对话记录'), 'no digest header')
  assert.ok(input.includes('需要改写的草稿'))
})

// 5. delta-less adapter: text recovered from block-end
await test('delta-less adapter recovers text from block-end', async () => {
  const llm = makeLlm({ chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'BLOCK-ONLY' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.deepEqual(result, { ok: true, text: 'BLOCK-ONLY', model: 'deepseek-v4.1-flash', route: 'request-header', format: 'plain' })
})

// 6. output sanitizing: fence + language tag, preamble line, wrapping quotes
await test('strips a wrapping markdown fence and language tag', async () => {
  const llm = makeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: '```markdown\n请修复 optimize.js 的 bug\n\n验收：node --check 通过\n```' },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '请修复 optimize.js 的 bug\n\n验收：node --check 通过')
})

await test('strips a preamble line and wrapping quotes', async () => {
  const llm = makeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: '以下是改写后的提示词：\n“请把 D:\\a\\b.js 的 maxTokens 改成 2048”' },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.text, '请把 D:\\a\\b.js 的 maxTokens 改成 2048')
})

await test('keeps a prompt that legitimately contains quotes', async () => {
  const llm = makeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: '请把日志里的 "timeout" 和 "retry" 两个字段改名' },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.text, '请把日志里的 "timeout" 和 "retry" 两个字段改名')
})

// ---------------------------------------------------------------------------
// commentary must never reach the composer
// ---------------------------------------------------------------------------

/** Feed one raw model answer through the whole pipeline and return the reply. */
async function replyFor(raw) {
  const llm = makeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: raw },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  return optimizePrompt({ sessions: { get: () => makeSession({ messages: [] }) }, llm }, { sessionId: 's', text: 'draft' })
}

/** The exact answer a real run produced for the "不要妥协" draft (see the bug report). */
const REPORTED_OUTPUT = [
  '不要做取舍，也不要退成折中方案。就按完整方案来做，一次性做到位——直接按最终形态实现，不要留“先这样、以后再收”的中间态。',
  '',
  '**更短的版本（如果要保持原来的力度）：**',
  '',
  '> 不要折中。按完整方案一次做到位，直接按最终形态实现。',
  '',
  '改动说明：原句“不要妥协”和“完美实现”表达的是同一层意思，即“别退让”，但“完美”容易被理解成主观质量标准；改写后改成可执行的要求——“完整方案、不留中间态、一次做到位”，力度不减，指向更明确。如果这句话是要发给执行方（子代理或实现环节），建议再补一句验收基准（例如“以统一入口 + 同一份 tab 状态为准，不以能跑通为通过”），否则“完整”仍会由对方自行定义。',
].join('\n')

await test('drops an alternative version and the change notes a model appends', async () => {
  const result = await replyFor(REPORTED_OUTPUT)
  assert.equal(result.ok, true)
  assert.equal(
    result.text,
    '不要做取舍，也不要退成折中方案。就按完整方案来做，一次性做到位——直接按最终形态实现，不要留“先这样、以后再收”的中间态。',
  )
  assert.doesNotMatch(result.text, /更短的版本/, 'no alternative version')
  assert.doesNotMatch(result.text, /改动说明/, 'no change notes')
  assert.doesNotMatch(result.text, /不要折中/, 'the shorter variant is gone too')
  assert.doesNotMatch(result.text, /建议|验收基准|执行方/, 'no advice for the user')
})

await test('drops an inline change-notes block and the advice after it', async () => {
  const raw = [
    '把 docs/README.md 的安装步骤补全到能一次跑通，并保持现有标题层级。',
    '',
    '改动说明：把“补全”具体化成了可验证的动作，并保留原有的层级约束。',
    '如果这是要交给子代理，建议再补一句验收基准。',
  ].join('\n')
  const result = await replyFor(raw)
  assert.equal(result.text, '把 docs/README.md 的安装步骤补全到能一次跑通，并保持现有标题层级。')
})

await test('an answer that is nothing but commentary is rejected, not shipped', async () => {
  const raw = '改动说明：原句过于啰嗦，我把它精简了。建议再补一句验收标准。'
  const result = await replyFor(raw)
  assert.equal(result.ok, false, 'no prompt was produced')
  assert.match(result.message, /没有返回可用的提示词/)
})

await test('a trailing advice paragraph is dropped, the prompt is kept', async () => {
  const raw = [
    '请把 src/a.ts 的 maxTokens 调到 2048，并补一个单元测试。',
    '',
    '如果这句话是要发给执行方（子代理或实现环节），建议再补一句验收基准，否则“完整”仍会由对方自行定义。',
  ].join('\n')
  const result = await replyFor(raw)
  assert.equal(result.text, '请把 src/a.ts 的 maxTokens 调到 2048，并补一个单元测试。')
})

await test('over-cutting guards: legitimate prompts keep their own labels and rules', async () => {
  // A plain label WITH content on the same line is a sentence of the prompt, not a section.
  const withLabel = [
    '注意：不要修改现有测试文件，也不要调整 tsconfig。',
    '说明：所有改动都要在 src/ 目录内完成。',
    '请把 版本号 从 1.2.3 升到 1.2.4，并同步 CHANGELOG。',
  ].join('\n')
  assert.equal((await replyFor(withLabel)).text, withLabel)
  // A horizontal rule inside the prompt is formatting, not a meta divider.
  const withRule = ['第一步：读 docs/protocol.md。', '---', '第二步：按文档改 optimize.js。'].join('\n')
  assert.equal((await replyFor(withRule)).text, withRule)
  // A closing conditional that is part of the instruction survives.
  const withConditional = '如果单元测试失败，先修实现再提交，不要放宽断言。'
  assert.equal((await replyFor(withConditional)).text, withConditional)
})

// ---------------------------------------------------------------------------
// structured answer: only the marked block reaches the draft
// ---------------------------------------------------------------------------

/** Build a marker-envelope answer, the shape the system prompt asks for. */
function envelope(promptText, notes = '') {
  return [
    '[[PROMPT_BEGIN]]',
    promptText,
    '[[PROMPT_END]]',
    '',
    '[[NOTES_BEGIN]]',
    notes,
    '[[NOTES_END]]',
  ].join('\n')
}

await test('reads only the marked block and throws away everything around it', async () => {
  const raw = [
    '好的，我帮你改写一下。',
    '',
    envelope(
      '把 src/a.ts 里的 maxTokens 改成 2048，并补一个覆盖超限分支的单元测试。',
      '原句只说了“改一下”，我补上了文件与验收标准。',
    ),
    '',
    '如果你要发给执行方，建议再补一句验收基准。',
  ].join('\n')
  const result = await replyFor(raw)
  assert.equal(result.ok, true)
  assert.equal(result.format, 'envelope')
  assert.equal(result.text, '把 src/a.ts 里的 maxTokens 改成 2048，并补一个覆盖超限分支的单元测试。')
  assert.doesNotMatch(result.text, /好的|改写一下|验收基准|原句/, 'no prose, no notes, no advice')
})

await test('the notes block is never shipped even when it is long and prompt-shaped', async () => {
  const raw = envelope(
    '请把 docs/README.md 的安装步骤补全到能一次跑通。',
    '改动说明：把“补全”具体化了。\n\n更短的版本：补全 README 安装步骤。',
  )
  const result = await replyFor(raw)
  assert.equal(result.text, '请把 docs/README.md 的安装步骤补全到能一次跑通。')
})

await test('tolerates decorated markers and an unterminated block', async () => {
  assert.equal(
    (await replyFor('**[[PROMPT_BEGIN]]**\n请升级 lodash 到 4.17.21。\n**[[PROMPT_END]]**')).text,
    '请升级 lodash 到 4.17.21。',
  )
  assert.equal(
    (await replyFor('[[PROMPT_BEGIN]]\n请升级 lodash 到 4.17.21。\n\n[[NOTES_BEGIN]]\n说明：安全修复。')).text,
    '请升级 lodash 到 4.17.21。',
  )
})

await test('falls back to a JSON answer when the model ignores the tags', async () => {
  const raw = '{"prompt": "把一个长函数按职责拆成三个，并保持现有导出不变。", "notes": "拆分建议"}'
  const result = await replyFor(raw)
  assert.equal(result.format, 'json')
  assert.equal(result.text, '把一个长函数按职责拆成三个，并保持现有导出不变。')

  const fenced = '```json\n{"prompt": "第一行\\n第二行"}\n```'
  const fencedResult = await replyFor(fenced)
  assert.equal(fencedResult.format, 'json')
  assert.equal(fencedResult.text, '第一行\n第二行', 'escaped newlines are decoded')
})

await test('falls back to a <prompt> element when there are no tags and no JSON', async () => {
  const result = await replyFor('<prompt>\n把 CI 的 node 版本固定到 22 并缓存 pnpm store。\n</prompt>\n\n说明：顺便提速。')
  assert.equal(result.format, 'xml')
  assert.equal(result.text, '把 CI 的 node 版本固定到 22 并缓存 pnpm store。')
})

await test('a plain answer without any envelope still works (back-compat)', async () => {
  const result = await replyFor('把 src/a.ts 的 maxTokens 调到 2048，并补一个单元测试。')
  assert.equal(result.format, 'plain')
  assert.equal(result.text, '把 src/a.ts 的 maxTokens 调到 2048，并补一个单元测试。')
})

// ---------------------------------------------------------------------------
// line breaks: the draft must arrive as real newlines, never as `\n` escapes
// ---------------------------------------------------------------------------

await test('decodes \\n escapes the model wrote instead of real line breaks', async () => {
  const result = await replyFor('[[PROMPT_BEGIN]]第一行\\n第二行\\n\\n第三步：提交[[PROMPT_END]]')
  assert.equal(result.format, 'envelope')
  assert.equal(result.text, '第一行\n第二行\n\n第三步：提交')
  assert.ok(result.text.includes('\n'), 'real newlines, so the composer makes paragraphs')
  assert.ok(!result.text.includes('\\n'), 'no escape sequence is left in the draft')
})

await test('decodes double-escaped and HTML line breaks too', async () => {
  assert.equal((await replyFor('[[PROMPT_BEGIN]]a\\\\nb[[PROMPT_END]]')).text, 'a\nb')
  assert.equal((await replyFor('[[PROMPT_BEGIN]]一行<br>二行[[PROMPT_END]]')).text, '一行\n二行')
})

await test('salvages a JSON answer whose string carries raw newlines', async () => {
  const raw = '{"prompt": "第一行\n第二行", "notes": "手写的 JSON，字符串里有真换行"}'
  const result = await replyFor(raw)
  assert.equal(result.format, 'json')
  assert.equal(result.text, '第一行\n第二行')
})

await test('keeps a prompt that only MENTIONS an escape sequence', async () => {
  const raw = "[[PROMPT_BEGIN]]把 '\\n' 这个转义原样保留，只改 split 的实现[[PROMPT_END]]"
  const result = await replyFor(raw)
  assert.equal(result.text, "把 '\\n' 这个转义原样保留，只改 split 的实现")
  assert.ok(result.text.includes('\\n'), 'a quoted escape is content, not a line break')
})

await test('real newlines are left exactly as they are', async () => {
  const raw = '[[PROMPT_BEGIN]]第一行\n第二行\n\n- 分点一\n- 分点二\n[[PROMPT_END]]'
  const result = await replyFor(raw)
  assert.equal(result.text, '第一行\n第二行\n\n- 分点一\n- 分点二')
})

await test('an empty block is rejected instead of shipping an empty draft', async () => {  const result = await replyFor(envelope('   ', '说明：我觉得原句已经够好了。'))
  assert.equal(result.ok, false)
  assert.match(result.message, /没有返回可用的提示词/)
})

// 7. failure branches
await test('rejects a blank draft without touching the model', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  for (const text of ['', '   ', '\n\t ']) {
    const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text })
    assert.equal(result.ok, false)
    assert.ok(result.message.length > 0)
  }
  assert.equal(llm.captured.prepareArgs.length, 0, 'no model call for a blank draft')
})

await test('rejects a draft over 20000 characters', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'x'.repeat(20001) })
  assert.equal(result.ok, false)
  assert.match(result.message, /20000/)
  assert.equal(llm.captured.prepareArgs.length, 0)
})

await test('accepts a draft of exactly 20000 characters', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'x'.repeat(20000) })
  assert.equal(result.ok, true)
})

await test('rejects a non-string draft', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's' })
  assert.equal(result.ok, false)
})

await test('unknown session -> ok:false with a clear reason', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt({ sessions: { get: () => undefined }, llm }, { sessionId: 'session-gone', text: 'draft' })
  assert.equal(result.ok, false)
  assert.match(result.message, /找不到当前会话/)
  assert.equal(llm.captured.prepareArgs.length, 0, 'never falls back to a guessed route')
})

await test('no route at all -> ok:false, never guesses a model', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  // NOTE: `makeSession({ header: undefined })` would hit the default parameter, so pass null.
  // This ctx exposes no fallback services either, so nothing at all can name a model.
  const session = makeSession({ header: null })
  const result = await optimizePrompt({ sessions: { get: () => session }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
  assert.match(result.message, /还无法确定/)
  assert.equal(llm.captured.prepareArgs.length, 0)
})

await test('header without provider/model -> ok:false', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const session = makeSession({ header: { config: { provider: '', model: '' } } })
  const result = await optimizePrompt({ sessions: { get: () => session }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
  assert.equal(llm.captured.prepareArgs.length, 0)
})

await test('missing sessions service -> ok:false', async () => {
  const result = await optimizePrompt({ llm: makeLlm({ chunks: HAPPY }) }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
})

await test('missing llm service -> ok:false', async () => {
  const result = await optimizePrompt({ sessions: { get: () => makeSession() } }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
  assert.match(result.message, /模型服务不可用/)
})

await test('no ctx at all -> ok:false (never throws)', async () => {
  assert.equal((await optimizePrompt(undefined, { sessionId: 's', text: 'draft' })).ok, false)
  assert.equal((await optimizePrompt({}, undefined)).ok, false)
})

await test('already-aborted caller signal -> ok:false and no dispatch', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const controller = new AbortController()
  controller.abort()
  const result = await optimizePrompt(
    { sessions: { get: () => makeSession() }, llm },
    { sessionId: 's', text: 'draft', signal: controller.signal },
  )
  assert.equal(result.ok, false)
  assert.match(result.message, /取消/)
  assert.equal(llm.captured.dispatches, 0)
})

await test('caller abort mid-stream -> ok:false, request cancelled', async () => {
  const controller = new AbortController()
  let aborted = false
  const llm = {
    prepareCall: async () => ({
      config: { provider: 'p', model: 'm', maxTokens: 2048 },
      stream: (options) => (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        aborted = true
        controller.abort()
        await new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
          if (options.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }),
  }
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft', signal: controller.signal })
  assert.equal(aborted, true)
  assert.equal(result.ok, false)
  assert.match(result.message, /取消/)
})

await test('internal 60s deadline aborts the stream -> timeout reason', async () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  // Compress the internal timer only; everything else stays real.
  globalThis.setTimeout = (fn, _ms, ...rest) => realSetTimeout(fn, 1, ...rest)
  try {
    const llm = {
      prepareCall: async (config, signal) => ({
        config: { provider: config.provider, model: config.model, maxTokens: config.maxTokens },
        stream: (options) => (async function* () {
          await new Promise((_, reject) => {
            if (!options.signal) throw new Error('signal must be passed to the adapter stream')
            options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
            if (options.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      }),
    }
    const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
    assert.equal(result.ok, false)
    assert.match(result.message, /超时/)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

await test('prepareCall rejection -> ok:false with the provider reason', async () => {
  const llm = makeLlm({ chunks: HAPPY, onPrepare: async () => { throw new Error('no adapter registered for provider "x"') } })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
  assert.match(result.message, /no adapter registered/)
})

await test('terminal error finish -> ok:false with the failure message', async () => {
  const llm = makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 529 overloaded', code: 'OVERLOADED', status: 529 } } }] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
  assert.match(result.message, /upstream 529 overloaded/)
})

await test('terminal aborted finish (not by us) -> ok:false', async () => {
  const llm = makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'stream closed', code: 'ABORTED' } } }] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
  assert.match(result.message, /stream closed/)
})

await test('max-tokens finish -> ok:false (truncated output rejected)', async () => {
  const llm = makeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: 'half a pro' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
  assert.match(result.message, /长度上限/)
})

await test('tool-calls finish -> ok:false', async () => {
  const llm = makeLlm({ chunks: [{ type: 'finish', reason: { kind: 'tool-calls' } }] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
})

await test('empty model output -> ok:false', async () => {
  const llm = makeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: '   \n  ' },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
  assert.match(result.message, /没有返回可用的提示词/)
})

await test('output that is only a fence with no body -> ok:false', async () => {
  const llm = makeLlm({ chunks: [
    { type: 'text-delta', index: 0, text: '```\n\n```' },
    { type: 'finish', reason: { kind: 'stop' } },
  ] })
  const result = await optimizePrompt({ sessions: { get: () => makeSession() }, llm }, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
})

// 8. non-model-visible guarantee: the module never mutates the session
await test('never appends events or mutates the session / session store', async () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
  ]
  const session = makeSession({ messages })
  let appends = 0
  session.append = () => { appends += 1 }
  const sessions = { get: (id) => (id === 'session-7' ? session : undefined), list: () => [session] }
  const llm = makeLlm({ chunks: HAPPY })
  const before = JSON.stringify(messages)
  const result = await optimizePrompt({ sessions, llm }, { sessionId: 'session-7', text: 'draft' })
  assert.equal(result.ok, true)
  assert.equal(appends, 0, 'no session.append')
  assert.equal(JSON.stringify(messages), before, 'derived history untouched')
  assert.equal(session.deriveMessages().length, 1, 'no message created in history')
})

// 9. determinism: two calls, two dispatches, independent text
await test('two calls dispatch independently', async () => {
  const session = makeSession()
  const llm = makeLlm({ chunks: HAPPY })
  const ctx = { sessions: { get: () => session }, llm }
  const first = await optimizePrompt(ctx, { sessionId: 'session-7', text: 'a' })
  const second = await optimizePrompt(ctx, { sessionId: 'session-7', text: 'b' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(llm.captured.dispatches, 2)
})

// ---------------------------------------------------------------------------
// v2: docked attachments as rewrite context
// ---------------------------------------------------------------------------

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64')

/**
 * A fake `ctx.attachments`: admits images and streams stored file bytes.
 * Any mutation entry point records a call so the test can prove it is never used.
 */
function makeStore({ onAdmit, files = {} } = {}) {
  const calls = { admitPromptContent: 0, readFileStream: [], mutated: [] }
  const store = {
    calls,
    async admitPromptContent(parts) {
      calls.admitPromptContent += 1
      if (onAdmit) return onAdmit(parts, calls)
      // Mirrors the real return: `{type:'image', attachment: ImageAttachmentRef}` per part.
      return parts.map((part, index) => ({
        type: 'image',
        attachment: {
          attachmentId: `att-${index + 1}`,
          mediaType: part.mediaType,
          bytes: 70,
          width: 468,
          height: 137,
          ...part.name === undefined ? {} : { name: part.name },
        },
      }))
    },
    async *readFileStream(ref) {
      calls.readFileStream.push(ref.attachmentId)
      const body = files[ref.attachmentId]
      if (body === undefined) throw new Error(`no fake bytes for ${ref.attachmentId}`)
      yield typeof body === 'string' ? new TextEncoder().encode(body) : body
    },
  }
  for (const name of ['removeAttachment', 'releaseDraftAttachment', 'pruneAttachments', 'saveImages', 'saveImage', 'saveFile']) {
    store[name] = (...args) => {
      calls.mutated.push(`${name}/${args.length}`)
      throw new Error(`${name} must never be called by prompt-polish`)
    }
  }
  return store
}

/** A fake `ctx.fileUploads` resolving receipt ids to durable file refs. */
function makeFileUploads(refs) {
  const calls = { resolve: [] }
  return {
    calls,
    resolve(agent, receiptId) {
      calls.resolve.push(receiptId)
      return refs[receiptId]
    },
  }
}

/** A fake `ctx.agents` yielding one agent for any live session id. */
const makeAgents = () => ({ get: (id) => (id === undefined ? undefined : { id }) })

/** Assemble the v2 ctx. */
function makeCtx({ store, fileUploads, agents = makeAgents(), llm, session = makeSession() } = {}) {
  return {
    sessions: { get: () => session },
    llm,
    ...store === undefined ? {} : { attachments: store },
    ...fileUploads === undefined ? {} : { fileUploads },
    agents,
  }
}

const dispatchedText = (llm) => llm.captured.options[0].messages[0].content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
const imagePayload = (extra = {}) => ({ type: 'image', mediaType: 'image/png', data: PNG_BASE64, name: 'image.png', ...extra })

await test('v2 image-capable route puts the admitted ref in an image block before the text', async () => {
  const store = makeStore()
  const llm = makeLlm({ chunks: HAPPY, modalities: ['text', 'image'] })
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads({}), llm }),
    { sessionId: 'session-7', text: '看看这张图里的按钮', attachments: [imagePayload()] },
  )
  assert.equal(result.ok, true)
  assert.equal(store.calls.admitPromptContent, 1, 'exactly one admission batch')
  const content = llm.captured.options[0].messages[0].content
  assert.equal(content.length, 2, 'one image block + one text block')
  assert.equal(content[0].type, 'image')
  assert.equal(content[0].attachment.attachmentId, 'att-1', 'the admitted ref is used verbatim as an image block')
  assert.equal(content[0].attachment.width, 468)
  assert.equal(content[1].type, 'text')
  assert.ok(content[1].text.includes('附件清单'), 'inventory present')
  assert.ok(content[1].text.includes('1. 图片 image.png'), 'numbered, named, rail order')
  assert.ok(content[1].text.includes('468×137'), 'real admitted dimensions')
  assert.ok(content[1].text.includes('模型可见：已作为图片随本请求提供'))
})

await test('v2 text-only route sends no image block but still inventories the image', async () => {
  const store = makeStore()
  const llm = makeLlm({ chunks: HAPPY }) // no inputModalities -> text only
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads({}), llm }),
    { sessionId: 'session-7', text: '看看这张图里的按钮', attachments: [imagePayload()] },
  )
  assert.equal(result.ok, true)
  const content = llm.captured.options[0].messages[0].content
  assert.equal(content.length, 1, 'text block only')
  assert.equal(content[0].type, 'text')
  assert.equal(store.calls.admitPromptContent, 1, 'admitted anyway, to report dimensions')
  assert.ok(content[0].text.includes('图片 image.png'))
  assert.ok(content[0].text.includes('468×137'))
  assert.ok(content[0].text.includes('模型不可见：本次模型不支持图片输入'))
})

await test('v2 refused image batch (TOO_MANY_IMAGES) still rewrites, inventory-only', async () => {
  const store = makeStore({
    onAdmit: async () => {
      throw Object.assign(new Error('Image batch exceeds the configured image-count limit.'), { code: 'TOO_MANY_IMAGES' })
    },
  })
  const llm = makeLlm({ chunks: HAPPY, modalities: ['text', 'image'] })
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads({}), llm }),
    { sessionId: 'session-7', text: '这张图怎么了', attachments: [imagePayload(), imagePayload({ name: 'image-2.png' })] },
  )
  assert.equal(result.ok, true, 'a refused batch never fails the rewrite')
  assert.equal(llm.captured.dispatches, 1)
  const content = llm.captured.options[0].messages[0].content
  assert.equal(content.length, 1, 'no image block without refs')
  assert.ok(content[0].text.includes('1. 图片 image.png'))
  assert.ok(content[0].text.includes('2. 图片 image-2.png'))
  assert.ok(content[0].text.includes('模型不可见：图片未能加载'))
  assert.ok(!content[0].text.includes('undefined'))
})

await test('v2 unknown file receipt degrades to a metadata-only line', async () => {
  const store = makeStore()
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads({}), llm }),
    { sessionId: 'session-7', text: '总结这个文件', attachments: [{ type: 'file', receiptId: 'receipt-missing', name: 'notes.md', bytes: 1234 }] },
  )
  assert.equal(result.ok, true)
  const text = dispatchedText(llm)
  assert.ok(text.includes('1. 文件 notes.md'))
  assert.ok(text.includes('1.2 KB'), 'hint size shown when the ref is missing')
  assert.ok(text.includes('模型不可见：找不到该文件的上传记录'))
  assert.equal(store.calls.readFileStream.length, 0, 'no bytes read')
})

await test('v2 text file excerpt is read, capped per file and in total', async () => {
  const body = 'X'.repeat(20000)
  const files = {}
  const refs = {}
  const attachments = []
  for (let i = 0; i < 4; i += 1) {
    files[`f-${i}`] = body
    refs[`r-${i}`] = { attachmentId: `f-${i}`, name: `doc-${i}.md`, bytes: 20000 }
    attachments.push({ type: 'file', receiptId: `r-${i}`, name: `doc-${i}.md`, bytes: 20000 })
  }
  const store = makeStore({ files })
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads(refs), llm }),
    { sessionId: 'session-7', text: '总结这些文档', attachments },
  )
  assert.equal(result.ok, true)
  const text = dispatchedText(llm)
  const excerpted = (text.match(/X/g) ?? []).length
  assert.equal(excerpted, 24576, '3 x 8 KB excerpts, then the 24 KB budget is exhausted')
  assert.ok(text.includes('模型可见：已提供前 8 KB 文本片段'))
  assert.ok(text.includes('--- doc-0.md（前 8 KB） ---'), 'excerpt section names the file')
  assert.ok(text.includes('4. 文件 doc-3.md'), 'before the excerpt section, the 4th file keeps its line')
  assert.ok(text.includes('模型不可见：已达到本次可读取的文本上限'))
  assert.equal(store.calls.readFileStream.length, 3, 'the fourth file is never opened')
})

await test('v2 short text file is included in full', async () => {
  const store = makeStore({ files: { 'f-1': 'hello attachment body' } })
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads({ r1: { attachmentId: 'f-1', name: 'notes.md', bytes: 21 } }), llm }),
    { sessionId: 'session-7', text: '看看附件', attachments: [{ type: 'file', receiptId: 'r1', name: 'notes.md' }] },
  )
  assert.equal(result.ok, true)
  const text = dispatchedText(llm)
  assert.ok(text.includes('模型可见：已提供全文文本'))
  assert.ok(text.includes('hello attachment body'))
  assert.ok(!text.includes('前 21 B'), 'not marked truncated')
})

await test('v2 binary file: metadata only, no bytes read', async () => {
  const store = makeStore()
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads({ r1: { attachmentId: 'f-pdf', name: 'report.pdf', bytes: 2516582 } }), llm }),
    { sessionId: 'session-7', text: '看看报告', attachments: [{ type: 'file', receiptId: 'r1', name: 'report.pdf', bytes: 2516582 }] },
  )
  assert.equal(result.ok, true)
  const text = dispatchedText(llm)
  assert.ok(text.includes('1. 文件 report.pdf'))
  assert.ok(text.includes('2.4 MB'))
  assert.ok(text.includes('模型不可见：非文本文件，只提供文件名与大小'))
  assert.equal(store.calls.readFileStream.length, 0, 'a binary file is never opened')
})

await test('v2 read failure on one file never fails the rewrite', async () => {
  const store = makeStore({ files: {} }) // readFileStream throws: no fake bytes
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads({ r1: { attachmentId: 'f-broken', name: 'gone.md', bytes: 10 } }), llm }),
    { sessionId: 'session-7', text: '看看这个', attachments: [{ type: 'file', receiptId: 'r1', name: 'gone.md' }] },
  )
  assert.equal(result.ok, true)
  assert.ok(dispatchedText(llm).includes('模型不可见：读取该文件失败'))
})

await test('v2 malformed attachments are ignored without failing', async () => {
  const store = makeStore()
  const llm = makeLlm({ chunks: HAPPY, modalities: ['text', 'image'] })
  const junk = [null, 5, 'x', [], {}, { type: 'image' }, { type: 'image', data: '' }, { type: 'image', data: 42 }, { type: 'file' }, { type: 'file', receiptId: '' }, { type: 'video', src: 'y' }, { name: 'no-type' }]
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads({}), llm }),
    { sessionId: 'session-7', text: 'draft', attachments: junk },
  )
  assert.equal(result.ok, true)
  assert.equal(store.calls.admitPromptContent, 0, 'no valid image to admit')
  assert.equal(store.calls.readFileStream.length, 0)
  const content = llm.captured.options[0].messages[0].content
  assert.equal(content.length, 1)
  assert.ok(!dispatchedText(llm).includes('附件清单'), 'no inventory for junk')
})

await test('v2 at most 8 attachments are considered', async () => {
  const files = {}
  const refs = {}
  const attachments = []
  for (let i = 0; i < 12; i += 1) {
    files[`f-${i}`] = 'tiny'
    refs[`r-${i}`] = { attachmentId: `f-${i}`, name: `n-${i}.txt`, bytes: 4 }
    attachments.push({ type: 'file', receiptId: `r-${i}`, name: `n-${i}.txt` })
  }
  const store = makeStore({ files })
  const llm = makeLlm({ chunks: HAPPY })
  const result = await optimizePrompt(
    makeCtx({ store, fileUploads: makeFileUploads(refs), llm }),
    { sessionId: 'session-7', text: 'draft', attachments },
  )
  assert.equal(result.ok, true)
  const lines = dispatchedText(llm).match(/^\d+\. /gm) ?? []
  assert.equal(lines.length, 8, 'capped at 8 in rail order')
  assert.equal(store.calls.readFileStream.length, 8)
})

await test('v2 never mutates, releases, or appends anything', async () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }]
  const session = makeSession({ messages })
  let appends = 0
  session.append = () => { appends += 1 }
  const before = JSON.stringify(messages)
  const store = makeStore({ files: { 'f-1': 'text body' } })
  const llm = makeLlm({ chunks: HAPPY, modalities: ['text', 'image'] })
  const result = await optimizePrompt(
    {
      sessions: { get: () => session, list: () => [session] },
      llm,
      attachments: store,
      fileUploads: makeFileUploads({ r1: { attachmentId: 'f-1', name: 'notes.md', bytes: 9 } }),
      agents: makeAgents(),
    },
    {
      sessionId: 'session-7',
      text: 'draft',
      attachments: [imagePayload(), { type: 'file', receiptId: 'r1', name: 'notes.md' }, { type: 'file', receiptId: 'r2', name: 'a.pdf', bytes: 10 }],
    },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(store.calls.mutated, [], 'no removal / release / save was called')
  assert.equal(appends, 0, 'no session.append')
  assert.equal(JSON.stringify(messages), before, 'derived history untouched')
  assert.equal(session.deriveMessages().length, 1, 'no message created')
})

// ---------------------------------------------------------------------------
// v3: no context at all — the very first message of a Session must still work
// ---------------------------------------------------------------------------

/**
 * A ctx carrying the optional route-resolution services.
 * @param {{ projection?: object | null, selection?: object | null, session: object, llm: object }} args
 * @returns a fake plugin context with `ctx.get`.
 */
function routeCtx({ projection = null, selection = null, session, llm }) {
  const services = {}
  if (projection !== null) services.sessionProjections = { stateOf: () => projection }
  if (selection !== null) services.agentDefaultModel = { currentSelection: () => selection }
  return { sessions: { get: () => session }, llm, get: (name) => services[name] }
}

await test('first message of a Session: works with no history and no request header', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const session = makeSession({ header: null, messages: [] })
  const ctx = routeCtx({
    session,
    llm,
    selection: { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' },
  })
  const result = await optimizePrompt(ctx, { sessionId: 's-first', text: '把这段整理成一条提示词' })
  assert.equal(result.ok, true, 'a brand-new Session is not refused: ' + JSON.stringify(result))
  assert.equal(result.route, 'default-selection')
  assert.equal(llm.captured.dispatches, 1, 'the rewrite really ran')
  assert.deepEqual(llm.captured.prepareArgs[0], {
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'medium',
  })
  // The default selection's reasoning effort must survive into the dispatch options.
  assert.equal(llm.captured.options[0].reasoningEffort, 'medium')
  // No history → no context block in the user input at all.
  const content = llm.captured.options[0].messages[0].content
  assert.equal(content.length, 1, 'a single text block when there is nothing else')
  assert.equal(content[0].type, 'text')
  assert.doesNotMatch(content[0].text, /最近对话记录/, 'no empty history framing')
  assert.doesNotMatch(content[0].text, /附件清单/, 'no empty attachment inventory')
  assert.match(content[0].text, /把这段整理成一条提示词/, 'the draft is still the subject')
})

await test('the system prompt tells the model that having no context is normal', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const session = makeSession({ header: null, messages: [] })
  const result = await optimizePrompt(routeCtx({ session, llm, selection: { provider: 'p', model: 'm' } }), {
    sessionId: 's',
    text: 'draft',
  })
  assert.equal(result.ok, true)
  const system = llm.captured.options[0].system
  assert.match(system, /第一条消息/, 'names the first-message case')
  assert.match(system, /缺少上下文/, 'forbids asking the user for context')
})

await test('no request header: the Session selection (pending) supplies the route', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const session = makeSession({ header: null, messages: [] })
  const ctx = routeCtx({
    session,
    llm,
    projection: {
      lastUsed: { provider: 'deepseek', model: 'old-model' },
      pending: { provider: 'deepseek', model: 'deepseek-v4.1-pro', reasoningEffort: 'high' },
    },
    selection: { provider: 'deepseek', model: 'deployment-default' },
  })
  const result = await optimizePrompt(ctx, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, true)
  assert.equal(result.route, 'session-selection')
  assert.equal(result.model, 'deepseek-v4.1-pro', 'the composer selection wins over the default')
  assert.equal(llm.captured.prepareArgs[0].reasoningEffort, 'high')
})

await test('no request header and no pending selection: lastUsed still supplies the route', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const session = makeSession({ header: null, messages: [] })
  const ctx = routeCtx({
    session,
    llm,
    projection: { lastUsed: { provider: 'deepseek', model: 'deepseek-v4.1-pro' }, pending: null },
  })
  const result = await optimizePrompt(ctx, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, true)
  assert.equal(result.route, 'session-selection')
  assert.equal(result.model, 'deepseek-v4.1-pro')
})

await test('a logged request header still wins over any selection', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const session = makeSession() // header = deepseek / deepseek-v4.1-flash
  const ctx = routeCtx({
    session,
    llm,
    projection: { lastUsed: null, pending: { provider: 'other', model: 'other-model' } },
    selection: { provider: 'other', model: 'deployment-default' },
  })
  const result = await optimizePrompt(ctx, { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, true)
  assert.equal(result.route, 'request-header')
  assert.equal(result.model, 'deepseek-v4.1-flash')
})

await test('no header, no selection, no default -> ok:false without dispatching', async () => {
  const llm = makeLlm({ chunks: HAPPY })
  const session = makeSession({ header: null, messages: [] })
  const result = await optimizePrompt(routeCtx({ session, llm }), { sessionId: 's', text: 'draft' })
  assert.equal(result.ok, false)
  assert.match(result.message, /还无法确定/)
  assert.equal(llm.captured.dispatches, 0)
})


console.log('')
if (failures.length > 0) {
  console.log(`FAILURES: ${failures.length}`)
  for (const failure of failures) console.log(`${failure.name}\n${failure.error && failure.error.stack}`)
  process.exitCode = 1
} else {
  console.log(`ALL PASS (${passed} checks)`)
}
