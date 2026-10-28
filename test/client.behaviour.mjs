/**
 * Behaviour test harness: a tiny hook runtime that renders the
 * two registered components of client.js and drives the four UI states + undo
 * invalidation + session release. No DOM, no packages installed.
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
const findButton = (tree) => findAll(tree, (n) => n.type === 'button')[0]
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.el === true) return node.children.map(textOf).join('')
  return ''
}
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

const t = (key) => dict['prompt-polish'].zh[key] ?? key
const Button = registered.find((r) => r.options.name === 'conversation.input.activity').component
const Skeleton = registered.find((r) => r.options.name === 'conversation.input.overlay').component

let draft = '把这段文案改得更好'
const writes = []
/** Emulate the composer's InputState store: every change re-renders subscribers. */
const setDraftExternal = (text) => {
  draft = text
  for (const inst of instances) inst.dirty = true
  flush()
}
const inputActions = { setDraft: (text) => { writes.push(text); setDraftExternal(text) } }
/**
 * The client's Session catalog, read through `useSessions`. Deleting an id models closing
 * or deleting that Session, which must drop any result that still arrives for it.
 */
const catalog = { byId: { 's-1': { blank: false }, 's-2': { blank: false }, 's-a': { blank: false }, 's-b': { blank: false }, 's-a2': { blank: false }, 's-gone': { blank: false }, 's-brand-new': { blank: true } } }
const makeProps = (sessionId) => ({
  sessionId,
  inputActions,
  useInput: (select) => select({ draft }),
  useSessions: (select) => select(catalog),
  t,
})

// request queue under test control
let pendingRequest = null
/** Every request ever issued, in order (the queue above only keeps the newest). */
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const results = []
const check = (cond, msg) => {
  results.push([Boolean(cond), msg])
  console.log((cond ? 'ok  - ' : 'FAIL- ') + msg)
}
//#endregion

//#region scenarios
const SESSION = 's-1'
const button = mount(Button, makeProps(SESSION))
const skeleton = mount(Skeleton, makeProps(SESSION))

let btn = findButton(button.tree)
check(btn !== undefined, 'idle: renders a button')
check(btn.props.type === 'button', 'idle: type=button')
check(btn.props['aria-label'] === t('button.polish'), 'idle: aria-label is the localized polish label')
check(btn.props.disabled === false || btn.props.disabled === undefined, 'idle: enabled for a non-blank draft')
check(btn.props['data-phase'] === 'idle', 'idle: data-phase=idle')
check(findAll(skeleton.tree, (n) => n.type === 'div' && n.props.className === 'pp-skeleton').length === 0, 'idle: no skeleton rendered')

// pending
btn.props.onClick()
flush()
btn = findButton(button.tree)
check(pendingRequest !== null, 'pending: POST issued')
check(pendingRequest.url === '/api/prompt-polish/optimize', 'pending: correct route')
check(pendingRequest.init.method === 'POST', 'pending: POST method')
check(pendingRequest.init.headers['content-type'] === 'application/json', 'pending: json content-type')
check(JSON.parse(pendingRequest.init.body).sessionId === SESSION, 'pending: body carries sessionId')
check(JSON.parse(pendingRequest.init.body).text === '把这段文案改得更好', 'pending: body carries the draft')
check(pendingRequest.init.signal !== undefined, 'pending: abortable via AbortSignal')
check(btn.props.disabled === true, 'pending: button disabled')
check(btn.props['aria-busy'] === 'true', 'pending: aria-busy=true')
check(btn.props['data-phase'] === 'pending', 'pending: data-phase=pending')
const skins = findAll(skeleton.tree, (n) => n.type === 'div' && n.props.className === 'pp-skeleton')
check(skins.length === 1, 'pending: skeleton mounted in the overlay slot')
const bars = findAll(skins[0], (n) => n.type === 'span' && n.props.className === 'pp-bar')
check(bars.length >= 2 && bars.length <= 4, 'pending: 2-4 shimmer bars, got ' + bars.length)
check(skins[0].props['aria-hidden'] === 'true', 'pending: skeleton aria-hidden')
const styleNode = findAll(skeleton.tree, (n) => n.type === 'style')[0]
check(styleNode !== undefined && String(textOf(styleNode)).includes('pp-shimmer'), 'pending: shimmer keyframes shipped from the component')
check(String(textOf(styleNode)).includes('pointer-events:none'), 'pending: skeleton is click-through')
check(String(textOf(styleNode)).includes('prefers-reduced-motion'), 'pending: reduced-motion fallback')
check(String(textOf(styleNode)).includes('z-index:1'), 'pending: skeleton paints above the editor')

// success
pendingRequest.resolve(jsonResponse({ ok: true, text: '请把这段文案润色得更清晰有力', model: 'deepseek-v4.1-flash' }))
await tick()
flush()
btn = findButton(button.tree)
check(writes.length === 1 && writes[0] === '请把这段文案润色得更清晰有力', 'done: setDraft applied the rewrite')
check(draft === '请把这段文案润色得更清晰有力', 'done: composer holds the rewrite')
check(btn.props['data-phase'] === 'done', 'done: data-phase=done')
check(btn.props['aria-label'] === t('button.undo'), 'done: aria-label is the localized undo label')
check(btn.props.disabled !== true, 'done: undo affordance is clickable')
check(findAll(skeleton.tree, (n) => n.props.className === 'pp-skeleton').length === 0, 'done: skeleton gone')

// undo
btn.props.onClick()
flush()
btn = findButton(button.tree)
check(writes.length === 2 && writes[1] === '把这段文案改得更好', 'undo: setDraft restored the captured original')
check(btn.props['data-phase'] === 'idle', 'undo: back to idle')

// undo invalidation when the user edits after the rewrite
setDraftExternal('把这段文案改得更好')
findButton(button.tree).props.onClick()
flush()
pendingRequest.resolve(jsonResponse({ ok: true, text: '润色后的文案', model: 'm' }))
await tick()
flush()
check(findButton(button.tree).props['data-phase'] === 'done', 're-rewrite: done again')
setDraftExternal('用户自己又改了')
check(findButton(button.tree).props['data-phase'] === 'idle', 'edit-after-rewrite: undo affordance dropped, no clobbering')

// failure keeps the draft and shows the host message verbatim
setDraftExternal('原始提示词')
findButton(button.tree).props.onClick()
flush()
pendingRequest.resolve(jsonResponse({ ok: false, message: '模型繁忙，请稍后重试' }))
await tick()
flush()
const errorNode = findAll(button.tree, (n) => n.props.className === 'pp-error')[0]
check(errorNode !== undefined, 'error: inline message node rendered')
check(textOf(errorNode) === '模型繁忙，请稍后重试', 'error: host message rendered as-is')
check(findButton(button.tree).props['data-phase'] === 'idle', 'error: back to idle')
check(draft === '原始提示词', 'error: draft untouched')
check(writes.length === 3, 'error: no setDraft call on failure')

// network failure
setDraftExternal('再来一次')
findButton(button.tree).props.onClick()
flush()
pendingRequest.reject(new TypeError('network down'))
await tick()
flush()
const netError = findAll(button.tree, (n) => n.props.className === 'pp-error')[0]
check(netError !== undefined && textOf(netError) === t('error.network'), 'network failure: localized error')

// session switch: the old request must never write into a draft
setDraftExternal('旧会话')
findButton(button.tree).props.onClick()
flush()
const stale = pendingRequest
setDraftExternal('新会话草稿')
unmount(button)
unmount(skeleton)
const button2 = mount(Button, makeProps('s-2'))
const skeleton2 = mount(Skeleton, makeProps('s-2'))
stale.resolve(jsonResponse({ ok: true, text: '不应写入', model: 'm' }))
await tick()
flush()
check(writes[writes.length - 1] !== '不应写入', 'session switch: stale response never writes')
check(findButton(button2.tree).props['data-phase'] === 'idle', 'session switch: new session starts idle')
check(findAll(skeleton2.tree, (n) => n.props.className === 'pp-skeleton').length === 0, 'session switch: no skeleton leaks')

// blank draft disables the control
setDraftExternal('   ')
check(findButton(button2.tree).props.disabled === true, 'blank draft: button disabled')

// ---------------------------------------------------------------------------
// no context at all: the first message of a Session must still be polishable.
// The button is gated on the draft only — never on history, projections or
// attachments — so a brand-new Session behaves exactly like any other.
// ---------------------------------------------------------------------------
setDraftExternal('把这段整理成一条提示词')
const freshButton = mount(Button, makeProps('s-brand-new'))
const freshSkeleton = mount(Skeleton, makeProps('s-brand-new'))
check(findButton(freshButton.tree).props.disabled !== true, 'first message: enabled with no history at all')
findButton(freshButton.tree).props.onClick()
flush()
check(pendingRequest !== null, 'first message: the request really goes out')
const firstBody = JSON.parse(pendingRequest.init.body)
check(firstBody.sessionId === 's-brand-new', 'first message: carries the new session id')
check(firstBody.text === '把这段整理成一条提示词', 'first message: carries the draft')
check(firstBody.attachments === undefined, 'first message: no attachment key when the dock is empty')
check(findButton(freshButton.tree).props['data-phase'] === 'pending', 'first message: enters pending')
check(findAll(freshSkeleton.tree, (n) => n.props.className === 'pp-skeleton').length === 1, 'first message: skeleton plays')
pendingRequest.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, text: '改写后的提示词', model: 'm' }) })
await tick()
flush()
check(writes[writes.length - 1] === '改写后的提示词', 'first message: the draft is rewritten')
check(findButton(freshButton.tree).props['data-phase'] === 'done', 'first message: undo is offered')

// ---------------------------------------------------------------------------
// switching Sessions never interrupts a rewrite
// ---------------------------------------------------------------------------
const respond = (request, text) => request.resolve({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ok: true, text, model: 'm' }),
})

// 1. leave mid-flight: the request keeps running, writes nothing into the Session that is
//    open now, and lands in the Session that started it once the user comes back.
setDraftExternal('甲会话的草稿')
const fromA = mount(Button, makeProps('s-a'))
findButton(fromA.tree).props.onClick()
flush()
const inflightA = requestLog[requestLog.length - 1]
check(inflightA !== undefined, 'switch: one request issued for the origin Session')
check(inflightA.init.signal.aborted === false, 'switch: the request is live when leaving')

unmount(fromA) // the composer moves to another Session
setDraftExternal('乙会话的草稿')
const onB = mount(Button, makeProps('s-b'))
flush()
check(inflightA.init.signal.aborted === false, 'switch: leaving the Session does not cancel the request')
check(findButton(onB.tree).props['data-phase'] === 'idle', 'switch: the other Session is not stuck pending')
const writesBeforeSwitch = writes.length
respond(inflightA, '优化后的甲草稿')
await tick()
flush()
check(inflightA.settled === true, 'switch: the response was consumed while the user was away')
check(writes.length === writesBeforeSwitch, 'switch: nothing is written into the Session that is open now')
check(!writes.includes('优化后的甲草稿'), 'switch: the away Session does not get its draft written yet')
check(findAll(onB.tree, (n) => n.props.className === 'pp-error').length === 0, 'switch: no error is surfaced elsewhere')

// back to the origin Session: the finished result is applied now, once
unmount(onB)
setDraftExternal('甲会话的草稿')
const backToA = mount(Button, makeProps('s-a'))
flush()
check(writes[writes.length - 1] === '优化后的甲草稿', 'switch: the result lands in the originating Session on return')
check(writes.filter((text) => text === '优化后的甲草稿').length === 1, 'switch: written exactly once')
check(findButton(backToA.tree).props['data-phase'] === 'done', 'switch: the control offers undo again')
unmount(backToA)

// 2. one in-flight request per Session: no duplicate dispatch, no concurrent writes
setDraftExternal('并发草稿')
const conc = mount(Button, makeProps('s-a2'))
findButton(conc.tree).props.onClick()
flush()
const issued = requestLog.length
findButton(conc.tree).props.onClick() // second click while in flight
flush()
check(requestLog.length === issued, 'concurrency: a second click while in flight issues nothing')
unmount(conc)
const concAgain = mount(Button, makeProps('s-a2')) // leave and come straight back
flush()
check(findButton(concAgain.tree).props['data-phase'] === 'pending', 'concurrency: returning shows the in-flight state')
findButton(concAgain.tree).props.onClick()
flush()
check(requestLog.length === issued, 'concurrency: re-entering the Session does not re-issue')
respond(requestLog[requestLog.length - 1], '并发改写完成')
await tick()
flush()
check(writes.filter((text) => text === '并发改写完成').length === 1, 'concurrency: the single result is written once')
unmount(concAgain)

// 3. the origin Session vanished: the result is dropped silently
setDraftExternal('即将消失的草稿')
const doomed = mount(Button, makeProps('s-gone'))
findButton(doomed.tree).props.onClick()
flush()
const inflightGone = requestLog[requestLog.length - 1]
delete catalog.byId['s-gone'] // closed / deleted while the request was running
unmount(doomed)
const writesBeforeGone = writes.length
respond(inflightGone, '不该写进去的改写')
await tick()
flush()
check(writes.length === writesBeforeGone, 'gone: a deleted Session never receives the result')
check(!writes.includes('不该写进去的改写'), 'gone: the discarded text never reached any draft')
const resurrect = mount(Button, makeProps('s-gone'))
flush()
check(findButton(resurrect.tree).props['data-phase'] === 'idle', 'gone: no residual state is left behind')
const unaffected = mount(Button, makeProps('s-b'))
flush()
check(findButton(unaffected.tree).props['data-phase'] === 'idle', 'gone: an unrelated Session is unaffected')
check(findAll(unaffected.tree, (n) => n.props.className === 'pp-error').length === 0, 'gone: no error appears elsewhere')
unmount(resurrect)
unmount(unaffected)

// Leave no request dangling: an unsettled fake request would keep the plugin's own timeout
// timer (and therefore this process) alive now that leaving a Session no longer aborts it.
for (const request of requestLog) {
  if (request.settled !== true) request.reject(Object.assign(new Error('harness cleanup'), { name: 'AbortError' }))
}
await tick()
flush()

const failed = results.filter(([ok]) => !ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
if (failed.length > 0) process.exitCode = 1
//#endregion
