/**
 * v2 plan-panel harness: renders the three registered components of client.js with the
 * same tiny hook runtime as `client.behaviour.mjs` and drives the diagnostic dock —
 * rendering, one-click clarification (wire shape), dedupe of answered questions,
 * failure rollback, closing, cross-Session write-back and client-side truncation.
 * No DOM, no Harness, no network.
 */
let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }

//#region mini react
const instances = new Set()
let currentInstance = null
let hookIndex = 0

const Fragment = Symbol('Fragment')
function createElement(type, props, ...children) {
  return { el: true, type, props: props ?? {}, children: children.flat(Infinity) }
}
const sameDeps = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
function useState(init) {
  const inst = currentInstance
  const i = hookIndex++
  let slot = inst.hooks[i]
  if (slot === undefined) {
    slot = { value: typeof init === 'function' ? init() : init }
    inst.hooks[i] = slot
  }
  const set = (next) => {
    const value = typeof next === 'function' ? next(slot.value) : next
    if (Object.is(value, slot.value)) return
    slot.value = value
    inst.dirty = true
    flush()
  }
  return [slot.value, set]
}
function useRef(init) {
  const inst = currentInstance
  const i = hookIndex++
  let slot = inst.hooks[i]
  if (slot === undefined) {
    slot = { value: { current: init } }
    inst.hooks[i] = slot
  }
  return slot.value
}
function useEffect(fn, deps) {
  const inst = currentInstance
  const i = hookIndex++
  let slot = inst.hooks[i]
  if (slot === undefined) {
    slot = { deps: null, cleanup: undefined, ran: false }
    inst.hooks[i] = slot
  }
  const changed = deps === undefined || slot.deps === null || !sameDeps(slot.deps, deps)
  if (deps !== undefined) slot.deps = [...deps]
  if (changed) inst.pending.push({ slot, fn })
}
const React = {
  Fragment,
  createElement,
  useState,
  useRef,
  useEffect,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
const requireStub = (name) => {
  if (name !== 'react') throw new Error('forbidden require: ' + name)
  return React
}

function renderInstance(inst) {
  const prev = currentInstance
  currentInstance = inst
  hookIndex = 0
  try {
    inst.tree = inst.Component(inst.props)
  } finally {
    currentInstance = prev
  }
}
function flushEffects(inst) {
  while (inst.pending.length > 0) {
    const batch = inst.pending.splice(0)
    for (const { slot, fn } of batch) {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      const cleanup = fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      slot.ran = true
    }
  }
}
function mount(Component, props) {
  const inst = { Component, props, hooks: [], pending: [], dirty: false, unmounted: false, tree: null }
  instances.add(inst)
  renderInstance(inst)
  flushEffects(inst)
  flush()
  return inst
}
function flush() {
  let guard = 0
  let again = true
  while (again && guard < 50) {
    again = false
    guard += 1
    for (const inst of Array.from(instances)) {
      if (inst.dirty && !inst.unmounted) {
        inst.dirty = false
        renderInstance(inst)
        flushEffects(inst)
        again = true
      }
    }
  }
}
function unmount(inst) {
  for (const hook of inst.hooks) {
    if (hook && typeof hook.cleanup === 'function') hook.cleanup()
  }
  inst.unmounted = true
  instances.delete(inst)
}
//#endregion

//#region tree helpers
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (node.el !== true) return
  visit(node)
  for (const child of node.children) walk(child, visit)
}
function findAll(tree, predicate) {
  const out = []
  walk(tree, (node) => {
    if (predicate(node)) out.push(node)
  })
  return out
}
const byClass = (tree, className) => findAll(tree, (n) => n.props?.className === className)
const findButton = (tree) => findAll(tree, (n) => n.type === 'button')[0]
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.el === true) return node.children.map(textOf).join('')
  return ''
}
const planRoots = (tree) => byClass(tree, 'pp-plan')
const optionsOf = (tree) => byClass(tree, 'pp-plan-option')
const chipsOf = (tree) => byClass(tree, 'pp-plan-chip')
const questionsOf = (tree) => byClass(tree, 'pp-plan-q')
/** The panel's one-line header. */
const titleOf = (tree) => textOf(byClass(tree, 'pp-plan-title')[0])
/** Unicode length, matching the client's clipping rule. */
const len = (text) => Array.from(text).length
//#endregion

//#region fixtures
await import(new URL('../client.js', import.meta.url).href)
const plugin = captured.factory(requireStub)

const registered = []
const dict = {}
const ctx = {
  effect(fn) {
    const d = fn()
    return typeof d === 'function' ? d : () => {}
  },
  locale: {
    register(ns, dictionaries) {
      dict[ns] = dictionaries
      return () => {}
    },
    bind: (ns) => (key) => dict[ns]?.zh?.[key] ?? key,
  },
  slots: {
    inject(_slot, factory) {
      factory()
      return () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
}
plugin.apply(ctx)

// The Host interpolates `{name}` placeholders in locale strings; mirror that here.
const interpolate = (template, params) => template.replace(
  /\{(\w+)\}/g,
  (match, name) => (params !== null && params !== undefined && Object.prototype.hasOwnProperty.call(params, name)
    ? String(params[name])
    : match),
)
const t = (key, params) => interpolate(dict['prompt-polish'].zh[key] ?? key, params)

const Button = registered.find((r) => r.options.name === 'conversation.input.activity')?.component
const Dock = registered.find((r) => r.options.name === 'conversation.input.dock')?.component

/** Per-Session composer drafts: switching Session selects a different input store. */
const drafts = new Map()
const writes = []
const catalog = {
  byId: {
    's-p': { blank: false },
    's-q': { blank: false },
    's-t': { blank: false },
    's-u': { blank: false },
    's-v': { blank: false },
    's-w': { blank: false },
  },
}
const setDraftExternal = (sessionId, text) => {
  drafts.set(sessionId, text)
  for (const inst of instances) inst.dirty = true
  flush()
}
const makeProps = (sessionId) => ({
  sessionId,
  inputActions: {
    setDraft: (text) => {
      writes.push({ sessionId, text })
      setDraftExternal(sessionId, text)
    },
  },
  useInput: (select) => select({ draft: drafts.get(sessionId) ?? '', attachmentIds: [] }),
  useSessions: (select) => select(catalog),
  t,
})

// request queue under test control
let pendingRequest = null
const requestLog = []
globalThis.fetch = (url, init) => {
  const request = { url, init, settled: false }
  pendingRequest = request
  requestLog.push(request)
  return new Promise((resolve, reject) => {
    request.resolve = (value) => { request.settled = true; resolve(value) }
    request.reject = (error) => { request.settled = true; reject(error) }
    init.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
}
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) })
const bodyOf = (request) => JSON.parse(request.init.body)
const answersOf = (request) => bodyOf(request).answers

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const results = []
const check = (cond, msg) => {
  results.push([Boolean(cond), msg])
  console.log((cond ? 'ok  - ' : 'FAIL- ') + msg)
}
//#endregion

//#region registration
const dockRegistration = registered.find((r) => r.options.name === 'conversation.input.dock')
check(dockRegistration !== undefined, 'registers conversation.input.dock')
check(dockRegistration?.options.id === 'prompt-polish-plan', 'dock id prompt-polish-plan')
check(dockRegistration?.options.order === 6, 'dock order 6')
//#endregion

//#region 1. no plan -> no panel
const SESSION = 's-p'
const ORIGINAL = '把这段代码改得好一点'
drafts.set(SESSION, ORIGINAL)
const button = mount(Button, makeProps(SESSION))
const dock = mount(Dock, makeProps(SESSION))
flush()
check(planRoots(dock.tree).length === 0, 'no plan: dock renders nothing (v1 fallback)')

//#endregion

//#region 2. a finished plan renders header, chips, questions, notes
findButton(button.tree).props.onClick()
flush()
const polishRequest = pendingRequest
check(polishRequest !== null, 'polish: request issued')
check(polishRequest.url === '/api/prompt-polish/optimize' && polishRequest.init.method === 'POST', 'polish: route + method')
check(bodyOf(polishRequest).text === ORIGINAL, 'polish: carries the draft')

const PLAN_1 = {
  type: 'coding',
  notes: '去掉了重复描述，补了验收标准',
  assumptions: [
    { slot: '输出格式', value: 'Markdown 表格' },
    { slot: '语言', value: '中文' },
  ],
  questions: [
    { q: '改哪个文件？', options: ['client.js', 'optimize.js', '你说了算'] },
    { q: '要不要保留旧接口？', options: ['保留', '不保留'] },
  ],
}
polishRequest.resolve(jsonResponse({ ok: true, text: '改写后的提示词', model: 'm', plan: PLAN_1 }))
await tick()
flush()

check(drafts.get(SESSION) === '改写后的提示词', 'plan: rewrite still applied to the draft')
check(planRoots(dock.tree).length === 1, 'plan: dock renders the panel')
check(titleOf(dock.tree) === '已按「编码任务」补全 2 处 · 2 个待确认', 'plan: header counts + type label, got ' + titleOf(dock.tree))
check(byClass(dock.tree, 'pp-plan-tag').map(textOf).join('|') === '补全|待确认', 'plan: section tags are localized')
check(chipsOf(dock.tree).length === 2, 'plan: one chip per assumption')
check(textOf(chipsOf(dock.tree)[0]) === '输出格式=Markdown 表格', 'plan: chip is slot=value')
check(questionsOf(dock.tree).length === 2, 'plan: one line per question')
check(textOf(questionsOf(dock.tree)[0]) === '改哪个文件？', 'plan: question text rendered')
check(optionsOf(dock.tree).length === 5, 'plan: 3 + 2 option buttons rendered')
check(byClass(dock.tree, 'pp-plan-recommended').length === 2, 'plan: every question marks its recommended option')
check(textOf(byClass(dock.tree, 'pp-plan-recommended')[0]) === '推荐', 'plan: recommended badge is localized')
check(textOf(byClass(dock.tree, 'pp-plan-notes')[0]) === '改动：去掉了重复描述，补了验收标准', 'plan: notes rendered as one line')
//#endregion

//#region 3. clicking an option replays the ORIGINAL draft
const firstOption = optionsOf(dock.tree).find((node) => textOf(node) === 'client.js')
check(firstOption !== undefined, 'refine: option button found')
firstOption.props.onClick()
flush()
check(pendingRequest !== polishRequest, 'refine: a second request is issued')
check(bodyOf(pendingRequest).text === ORIGINAL, 'refine: wire text is the ORIGINAL draft, not the rewrite')
check(JSON.stringify(answersOf(pendingRequest)) === JSON.stringify([{ q: '改哪个文件？', a: 'client.js' }]), 'refine: first answer sent as {q,a}')
check(bodyOf(pendingRequest).sessionId === SESSION, 'refine: carries the Session id')
check(bodyOf(pendingRequest).attachments === undefined, 'refine: no attachment key when the dock is empty')
check(byClass(dock.tree, 'pp-plan pp-plan-busy').length === 1, 'refine pending: panel collapses to one busy line')
check(textOf(byClass(dock.tree, 'pp-plan-busy-text')[0]) === '按你的选择重写…', 'refine pending: localized busy line')
check(optionsOf(dock.tree).length === 0, 'refine pending: option buttons are gone')
const busyChips = chipsOf(dock.tree)
check(busyChips.length === 2 && busyChips.every((node) => node.props['data-disabled'] === 'true'), 'refine pending: assumption chips stay but are disabled')
check(findButton(button.tree).props['data-phase'] === 'pending', 'refine pending: button shows the spinner')

// single flight: a stale click (from the tree rendered before the request) issues nothing
const issuedBeforeStaleClick = requestLog.length
firstOption.props.onClick()
flush()
check(requestLog.length === issuedBeforeStaleClick, 'refine: a second click while in flight is a no-op')
//#endregion

//#region 4. refine success refreshes the plan and dedupes answered questions
const PLAN_2 = {
  type: 'coding',
  assumptions: [{ slot: '语言', value: '中文' }],
  questions: [
    { q: '改哪个文件？', options: ['client.js', 'optimize.js'] }, // answered: must not be asked again
    { q: '要不要保留旧接口？', options: ['保留', '不保留'] },
  ],
}
pendingRequest.resolve(jsonResponse({ ok: true, text: '二次改写结果', model: 'm', plan: PLAN_2 }))
await tick()
flush()
check(drafts.get(SESSION) === '二次改写结果', 'refine: new text applied by the button write effect')
check(planRoots(dock.tree).length === 1, 'refine: panel stays after success')
check(questionsOf(dock.tree).length === 1, 'refine: answered question is not rendered again')
check(textOf(questionsOf(dock.tree)[0]) === '要不要保留旧接口？', 'refine: the remaining question is kept')
check(titleOf(dock.tree) === '已按「编码任务」补全 1 处 · 1 个待确认', 'refine: header recounts after refresh, got ' + titleOf(dock.tree))
check(chipsOf(dock.tree).length === 1 && textOf(chipsOf(dock.tree)[0]) === '语言=中文', 'refine: assumptions refreshed')
//#endregion

//#region 5. answers accumulate; a new question appears
const keepOption = optionsOf(dock.tree).find((node) => textOf(node) === '不保留')
keepOption.props.onClick()
flush()
check(JSON.stringify(answersOf(pendingRequest)) === JSON.stringify([
  { q: '改哪个文件？', a: 'client.js' },
  { q: '要不要保留旧接口？', a: '不保留' },
]), 'refine: previous answers accumulate in order')
check(bodyOf(pendingRequest).text === ORIGINAL, 'refine: still replays the original draft')

const PLAN_3 = {
  type: 'coding',
  assumptions: [{ slot: '语言', value: '中文' }],
  questions: [
    { q: '改哪个文件？', options: ['client.js', 'optimize.js'] },
    { q: '要不要保留旧接口？', options: ['保留', '不保留'] },
    { q: '要不要加测试？', options: ['加', '不加'] },
  ],
}
pendingRequest.resolve(jsonResponse({ ok: true, text: '三次改写结果', model: 'm', plan: PLAN_3 }))
await tick()
flush()
check(drafts.get(SESSION) === '三次改写结果', 'refine: third round applied')
check(questionsOf(dock.tree).length === 1 && textOf(questionsOf(dock.tree)[0]) === '要不要加测试？', 'refine: only the unanswered question remains')
//#endregion

//#region 6. a failed refine keeps the draft AND the panel
const addOption = optionsOf(dock.tree).find((node) => textOf(node) === '加')
addOption.props.onClick()
flush()
check(JSON.stringify(answersOf(pendingRequest)) === JSON.stringify([
  { q: '改哪个文件？', a: 'client.js' },
  { q: '要不要保留旧接口？', a: '不保留' },
  { q: '要不要加测试？', a: '加' },
]), 'refine: third answer joins the list')
const writesBeforeFailure = writes.length
pendingRequest.resolve(jsonResponse({ ok: false, message: '模型繁忙，请稍后重试' }))
await tick()
flush()
check(drafts.get(SESSION) === '三次改写结果', 'refine failure: draft untouched')
check(writes.length === writesBeforeFailure, 'refine failure: no setDraft call')
check(planRoots(dock.tree).length === 1, 'refine failure: panel stays')
check(questionsOf(dock.tree).length === 1, 'refine failure: remaining question still offered')
const refineError = byClass(button.tree, 'pp-error')[0]
check(refineError !== undefined && textOf(refineError) === '模型繁忙，请稍后重试', 'refine failure: host message surfaced beside the button')
check(findButton(button.tree).props['data-phase'] === 'done', 'refine failure: undo affordance kept')
check(findButton(button.tree).props['aria-label'] === t('button.undo'), 'refine failure: label still says undo')
//#endregion

//#region 7. a refine result lands in the ORIGINATING Session
const notNow = optionsOf(dock.tree).find((node) => textOf(node) === '不加')
notNow.props.onClick()
flush()
const crossRequest = pendingRequest
check(bodyOf(crossRequest).text === ORIGINAL, 'cross-session: refine replays the original draft')
const writesBeforeSwitch = writes.length
unmount(button)
unmount(dock)
setDraftExternal('s-q', '另一个会话的草稿')
const otherButton = mount(Button, makeProps('s-q'))
const otherDock = mount(Dock, makeProps('s-q'))
flush()
check(findButton(otherButton.tree).props['data-phase'] === 'idle', 'cross-session: the open Session stays idle')
check(planRoots(otherDock.tree).length === 0, 'cross-session: no panel leaks into the other Session')
crossRequest.resolve(jsonResponse({ ok: true, text: '跨会话改写结果', model: 'm', plan: { type: 'coding', assumptions: [{ slot: '测试', value: '不加' }] } }))
await tick()
flush()
check(writes.length === writesBeforeSwitch, 'cross-session: nothing is written while the user is away')
check(drafts.get('s-q') === '另一个会话的草稿', 'cross-session: the open draft is untouched')
check(writes.every((write) => write.sessionId !== 's-q'), 'cross-session: no write into the open Session')
check(byClass(otherButton.tree, 'pp-error').length === 0, 'cross-session: no error surfaced elsewhere')

// back to the origin Session: the result is written now, exactly once
unmount(otherButton)
unmount(otherDock)
const backButton = mount(Button, makeProps(SESSION))
const backDock = mount(Dock, makeProps(SESSION))
flush()
check(drafts.get(SESSION) === '跨会话改写结果', 'cross-session: the result lands in the originating Session')
check(writes.filter((write) => write.sessionId === SESSION && write.text === '跨会话改写结果').length === 1, 'cross-session: written exactly once')
check(planRoots(backDock.tree).length === 1, 'cross-session: the refreshed panel is there on return')
//#endregion

//#region 8. closing the panel keeps undo
const closeButton = byClass(backDock.tree, 'pp-plan-close')[0]
check(closeButton !== undefined, 'close: the panel has an × control')
closeButton.props.onClick()
flush()
check(planRoots(backDock.tree).length === 0, 'close: the panel hides')
check(findButton(backButton.tree).props['data-phase'] === 'done', 'close: the button still offers undo')
findButton(backButton.tree).props.onClick()
flush()
check(drafts.get(SESSION) === ORIGINAL, 'close: undo restores the ORIGINAL draft, not the rewrite')
check(findButton(backButton.tree).props['data-phase'] === 'idle', 'close: undo settles back to idle')
//#endregion

//#region 8b. a planless refine reply closes the panel (the old plan describes stale text)
const staleSession = 's-w'
const STALE_ORIGINAL = '把这段旧说明改好一点'
drafts.set(staleSession, STALE_ORIGINAL)
const staleButton = mount(Button, makeProps(staleSession))
const staleDock = mount(Dock, makeProps(staleSession))
flush()
findButton(staleButton.tree).props.onClick()
flush()
pendingRequest.resolve(jsonResponse({
  ok: true,
  text: '第一次改写结果',
  model: 'm',
  plan: {
    type: 'writing',
    assumptions: [{ slot: '语言', value: '中文' }],
    questions: [{ q: '给谁看？', options: ['新人', '专家'] }],
  },
}))
await tick()
flush()
check(planRoots(staleDock.tree).length === 1, 'planless refine: the panel is up before the round')
optionsOf(staleDock.tree).find((node) => textOf(node) === '新人').props.onClick()
flush()
check(bodyOf(pendingRequest).text === STALE_ORIGINAL, 'planless refine: replays the original draft')
pendingRequest.resolve(jsonResponse({ ok: true, text: '第二次改写结果', model: 'm' }))
await tick()
flush()
check(drafts.get(staleSession) === '第二次改写结果', 'planless refine: the new text is applied')
check(planRoots(staleDock.tree).length === 0, 'planless refine: the stale plan is dropped, panel hides')
check(findButton(staleButton.tree).props['data-phase'] === 'done', 'planless refine: undo is still offered')
check(findButton(staleButton.tree).props['aria-label'] === t('button.undo'), 'planless refine: label still says undo')
findButton(staleButton.tree).props.onClick()
flush()
check(drafts.get(staleSession) === STALE_ORIGINAL, 'planless refine: undo restores the ORIGINAL draft')
unmount(staleButton)
unmount(staleDock)
//#endregion

//#region 9. type label mapping + client-side truncation
const truncSession = 's-t'
drafts.set(truncSession, '写一段产品介绍文案')
const truncButton = mount(Button, makeProps(truncSession))
const truncDock = mount(Dock, makeProps(truncSession))
flush()
findButton(truncButton.tree).props.onClick()
flush()
const longValue = '很长的取值'.repeat(20)
const longNote = '备注'.repeat(100)
const longQuestion = '这个问题很长'.repeat(10)
const longOption = '候选答案'.repeat(10)
pendingRequest.resolve(jsonResponse({
  ok: true,
  text: '写好的产品介绍',
  model: 'm',
  plan: {
    type: 'writing',
    notes: longNote,
    assumptions: Array.from({ length: 8 }, (_v, index) => ({
      slot: `槽位${index}`,
      value: index === 0 ? longValue : `值${index}`,
    })),
    questions: [{ q: longQuestion, options: ['一', '二', '三', longOption, '五', '六'] }],
  },
}))
await tick()
flush()

check(drafts.get(truncSession) === '写好的产品介绍', 'type: rewrite applied')
check(titleOf(truncDock.tree) === '已按「写作任务」补全 6 处 · 1 个待确认', 'type: writing maps to 写作任务 and counts are display-capped, got ' + titleOf(truncDock.tree))
check(chipsOf(truncDock.tree).length === 6, 'truncate: assumptions capped at 6')
const firstChip = textOf(chipsOf(truncDock.tree)[0])
check(firstChip.endsWith('…') && len(firstChip.slice('槽位0='.length)) === 60, 'truncate: assumption value clipped to 60 chars')
check(len(textOf(questionsOf(truncDock.tree)[0])) === 40 && textOf(questionsOf(truncDock.tree)[0]).endsWith('…'), 'truncate: question clipped to 40 chars')
check(optionsOf(truncDock.tree).length === 4, 'truncate: options capped at 4')
check(textOf(optionsOf(truncDock.tree)[3]).endsWith('…') && len(textOf(optionsOf(truncDock.tree)[3])) === 20, 'truncate: option clipped to 20 chars')
const notesText = textOf(byClass(truncDock.tree, 'pp-plan-notes')[0])
check(notesText.startsWith('改动：') && notesText.endsWith('…') && len(notesText) === len('改动：') + 120, 'truncate: notes clipped to 120 chars')
unmount(truncButton)
unmount(truncDock)
//#endregion

//#region 10. unknown type omits the label; no plan keeps the v1 UI
const unknownSession = 's-u'
drafts.set(unknownSession, '把这件事说清楚')
const unknownButton = mount(Button, makeProps(unknownSession))
const unknownDock = mount(Dock, makeProps(unknownSession))
flush()
findButton(unknownButton.tree).props.onClick()
flush()
pendingRequest.resolve(jsonResponse({
  ok: true,
  text: '说清楚的结果',
  model: 'm',
  plan: { type: 'physics', assumptions: [{ slot: '长度', value: '短' }] },
}))
await tick()
flush()
check(titleOf(unknownDock.tree) === '已补全 1 处', 'unknown type: label omitted, got ' + titleOf(unknownDock.tree))
check(!titleOf(unknownDock.tree).includes('「'), 'unknown type: no quote placeholder leaks')
unmount(unknownButton)
unmount(unknownDock)

const plainSession = 's-v'
drafts.set(plainSession, '没有诊断的草稿')
const plainButton = mount(Button, makeProps(plainSession))
const plainDock = mount(Dock, makeProps(plainSession))
flush()
findButton(plainButton.tree).props.onClick()
flush()
pendingRequest.resolve(jsonResponse({ ok: true, text: '没有诊断的结果', model: 'm' }))
await tick()
flush()
check(drafts.get(plainSession) === '没有诊断的结果', 'no plan: v1 rewrite still applied')
check(planRoots(plainDock.tree).length === 0, 'no plan: done state renders no panel')
check(findButton(plainButton.tree).props['data-phase'] === 'done', 'no plan: undo still offered')
unmount(plainButton)
unmount(plainDock)
//#endregion

// Leave no request dangling (an unsettled fake request keeps the plugin's timeout alive).
for (const request of requestLog) {
  if (request.settled !== true) request.reject(Object.assign(new Error('harness cleanup'), { name: 'AbortError' }))
}
await tick()
flush()

const failed = results.filter(([ok]) => !ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
if (failed.length > 0) process.exitCode = 1
