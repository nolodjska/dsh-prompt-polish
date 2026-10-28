/**
 * Attachment test harness: proves the v2 draft-attachment path of
 * client.js — collection, caps, wire shape, read-only dock, and best-effort failure.
 * No DOM, no packages installed.
 */
let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }

//#region timer spy (records only long request budgets, ignores the harness tick)
const timerDelays = []
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, delay, ...rest) => {
  if (typeof delay === 'number' && delay >= 1000) timerDelays.push(delay)
  return realSetTimeout(fn, delay, ...rest)
}
const lastBudget = () => timerDelays[timerDelays.length - 1]
//#endregion

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
    slot = { deps: null, cleanup: undefined }
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
    }
  }
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
function mount(Component, props) {
  const inst = { Component, props, hooks: [], pending: [], dirty: false, unmounted: false, tree: null }
  instances.add(inst)
  renderInstance(inst)
  flushEffects(inst)
  flush()
  return inst
}
function unmount(inst) {
  for (const hook of inst.hooks) if (hook && typeof hook.cleanup === 'function') hook.cleanup()
  inst.unmounted = true
  instances.delete(inst)
}
function findAll(tree, predicate) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.el !== true) return
    if (predicate(node)) out.push(node)
    node.children.forEach(walk)
  }
  walk(tree)
  return out
}
const findButton = (tree) => findAll(tree, (n) => n.type === 'button')[0]
//#endregion

//#region fixtures
await import(new URL('../client.js', import.meta.url).href)
const plugin = captured.factory(requireStub)

/** Names of conversation methods that would MUTATE the composer's docked attachments. */
const MUTATORS = [
  'releaseDraftAttachment',
  'releaseDraftAttachments',
  'removeAttachment',
  'pruneAttachments',
  'addAttachments',
  'clearDraftAttachments',
]

let serializeCalls = []
let serializeImpl = async () => ({ attachments: [] })
let mutatorCalls = []
let serviceMode = 'present' // 'present' | 'missing-service' | 'missing-method'

const conversationService = {}
for (const name of MUTATORS) {
  conversationService[name] = (...args) => {
    mutatorCalls.push({ name, args })
  }
}
conversationService.serializeDraftAttachments = (ids) => {
  serializeCalls.push([...ids])
  return serializeImpl(ids)
}

const registered = []
const dict = {}
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get(name) {
    if (name !== 'conversation') return undefined
    if (serviceMode === 'missing-service') return undefined
    if (serviceMode === 'missing-method') return {}
    return conversationService
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

let draft = '把这段提示词改好'
let attachmentIds = []
const setDraftExternal = (text) => {
  draft = text
  for (const inst of instances) inst.dirty = true
  flush()
}
const writes = []
const otherInputCalls = []
const inputActions = {
  setDraft: (text) => {
    writes.push(text)
    setDraftExternal(text)
  },
}
for (const name of ['removeAttachment', 'pruneAttachments', 'addAttachments', 'releaseDraftAttachment', 'submit']) {
  inputActions[name] = (...args) => otherInputCalls.push({ name, args })
}
const makeProps = (sessionId) => ({
  sessionId,
  inputActions,
  useInput: (select) => select({ draft, attachmentIds }),
  t,
})

let requests = []
globalThis.fetch = (url, init) => {
  const request = { url, init }
  request.body = init && init.body ? JSON.parse(init.body) : null
  requests.push(request)
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
const tick = () => new Promise((resolve) => realSetTimeout(resolve, 0))
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const results = []
const check = (cond, msg) => {
  results.push([Boolean(cond), msg])
  console.log((cond ? 'ok  - ' : 'FAIL- ') + msg)
}
const reset = () => {
  // A switched-away Session no longer aborts its in-flight work, so an unresolved request
  // left behind by the previous scenario would keep the plugin's timeout timer (and this
  // process) alive. Settle them before dropping the reference.
  for (const request of requests) {
    if (request.settled !== true) request.reject(Object.assign(new Error('scenario reset'), { name: 'AbortError' }))
  }
  serializeCalls = []
  mutatorCalls = []
  otherInputCalls.length = 0
  writes.length = 0
  requests = []
  timerDelays.length = 0
  attachmentIds = []
  serviceMode = 'present'
  draft = '把这段提示词改好'
}
const imageEntry = (data, name) => ({ type: 'image', mediaType: 'image/png', data, ...(name ? { name } : {}) })
//#endregion

//#region A: ids are collected and sent in rail order
{
  reset()
  attachmentIds = ['drag-1', 'drag-2']
  serializeImpl = async () => ({ attachments: [imageEntry('QUJD', 'shot.png'), { type: 'file', receiptId: 'receipt-9' }] })
  const button = mount(Button, makeProps('s-1'))
  findButton(button.tree).props.onClick()
  await tick()
  check(serializeCalls.length === 1, 'A: serializeDraftAttachments called once')
  check(JSON.stringify(serializeCalls[0]) === JSON.stringify(['drag-1', 'drag-2']), 'A: ids forwarded in rail order')
  check(requests.length === 1, 'A: exactly one request issued')
  const body = requests[0].body
  check(body.sessionId === 's-1' && body.text === '把这段提示词改好', 'A: body carries sessionId + draft text')
  check(Array.isArray(body.attachments) && body.attachments.length === 2, 'A: both attachments present')
  check(body.attachments[0].type === 'image' && body.attachments[0].mediaType === 'image/png'
    && body.attachments[0].data === 'QUJD' && body.attachments[0].name === 'shot.png', 'A: image matches the documented shape')
  check(body.attachments[1].type === 'file' && body.attachments[1].receiptId === 'receipt-9'
    && Object.keys(body.attachments[1]).length === 2, 'A: file carries only receiptId')
  check(lastBudget() === 120000, 'A: images raise the budget to 120s, got ' + lastBudget())
  requests[0].resolve(jsonResponse({ ok: true, text: '改写后的提示词', model: 'm' }))
  await tick()
  check(writes[writes.length - 1] === '改写后的提示词', 'A: rewrite still applied with attachments')
  unmount(button)
}

//#region B: text-only stays synchronous, no attachments key, 90s budget
{
  reset()
  serializeImpl = async () => {
    throw new Error('must not be called')
  }
  const button = mount(Button, makeProps('s-2'))
  findButton(button.tree).props.onClick()
  check(requests.length === 1, 'B: request issued synchronously (no attachment await)')
  check(serializeCalls.length === 0, 'B: serialization skipped when the dock is empty')
  check(!('attachments' in requests[0].body), 'B: attachments key omitted entirely')
  check(lastBudget() === 90000, 'B: text-only keeps the 90s budget, got ' + lastBudget())
  requests[0].resolve(jsonResponse({ ok: true, text: 'x', model: 'm' }))
  await tick()
  unmount(button)
}

//#region C: at most 8 attachments
{
  reset()
  attachmentIds = Array.from({ length: 12 }, (_, i) => 'id-' + i)
  serializeImpl = async () => ({ attachments: attachmentIds.map((_v, i) => ({ type: 'file', receiptId: 'r-' + i })) })
  const button = mount(Button, makeProps('s-3'))
  findButton(button.tree).props.onClick()
  await tick()
  check(requests[0].body.attachments.length === 8, 'C: capped at 8 attachments, got ' + requests[0].body.attachments.length)
  check(requests[0].body.attachments[7].receiptId === 'r-7', 'C: keeps rail order, drops the tail')
  check(lastBudget() === 90000, 'C: files alone keep the 90s budget')
  requests[0].resolve(jsonResponse({ ok: true, text: 'x', model: 'm' }))
  await tick()
  unmount(button)
}

//#region D: oversized single image is dropped, total encoded cap stops the rest
{
  reset()
  attachmentIds = ['a', 'b']
  serializeImpl = async () => ({
    attachments: [imageEntry('A'.repeat(8_400_001)), { type: 'file', receiptId: 'kept' }],
  })
  const button = mount(Button, makeProps('s-4'))
  findButton(button.tree).props.onClick()
  await tick()
  const body = requests[0].body
  check(body.attachments.length === 1 && body.attachments[0].receiptId === 'kept', 'D: >6MB image dropped, rest kept')
  check(lastBudget() === 90000, 'D: no image survived, so the 90s budget applies')
  requests[0].resolve(jsonResponse({ ok: true, text: 'x', model: 'm' }))
  await tick()
  unmount(button)
}
{
  reset()
  attachmentIds = ['i1', 'i2', 'i3', 'i4', 'i5']
  const big = 'B'.repeat(8_000_000)
  serializeImpl = async () => ({ attachments: [imageEntry(big), imageEntry(big), imageEntry(big), imageEntry(big), imageEntry(big)] })
  const button = mount(Button, makeProps('s-5'))
  findButton(button.tree).props.onClick()
  await tick()
  check(requests[0].body.attachments.length === 4, 'D: 24MB encoded cap stops the payload at 4 images, got ' + requests[0].body.attachments.length)
  check(lastBudget() === 120000, 'D: surviving images keep the 120s budget')
  requests[0].resolve(jsonResponse({ ok: true, text: 'x', model: 'm' }))
  await tick()
  unmount(button)
}

//#region E: a throwing serializer never blocks the rewrite
{
  reset()
  attachmentIds = ['pending-upload']
  serializeImpl = async () => {
    throw new Error('conversation.serializeDraftAttachments: one or more files have not finished uploading')
  }
  const button = mount(Button, makeProps('s-6'))
  const logged = []
  const realError = console.error
  console.error = (...args) => logged.push(args.join(' '))
  findButton(button.tree).props.onClick()
  await tick()
  console.error = realError
  check(requests.length === 1, 'E: request still issued after a serializer failure')
  check(!('attachments' in requests[0].body), 'E: degrades to no attachments, not a failure')
  check(logged.some((line) => line.includes('prompt-polish')), 'E: failure is logged for diagnosis')
  requests[0].resolve(jsonResponse({ ok: true, text: '仍可优化', model: 'm' }))
  await tick()
  check(writes[writes.length - 1] === '仍可优化', 'E: rewrite completes normally')
  check(findAll(button.tree, (n) => n.props.className === 'pp-error').length === 0, 'E: no user-visible attachment error')
  unmount(button)
}

//#region F: a missing service / method degrades silently
for (const mode of ['missing-service', 'missing-method']) {
  reset()
  serviceMode = mode
  attachmentIds = ['x']
  serializeImpl = async () => {
    throw new Error('must not be called')
  }
  const button = mount(Button, makeProps('s-7-' + mode))
  findButton(button.tree).props.onClick()
  await tick()
  check(requests.length === 1 && !('attachments' in requests[0].body), 'F(' + mode + '): rewrite runs without attachments')
  check(serializeCalls.length === 0, 'F(' + mode + '): feature-detect avoids the call')
  requests[0].resolve(jsonResponse({ ok: true, text: 'x', model: 'm' }))
  await tick()
  unmount(button)
}

//#region G: switching Sessions mid-flight neither cancels nor writes into the other draft
{
  reset()
  attachmentIds = ['slow']
  const gate = deferred()
  serializeImpl = () => gate.promise
  const button = mount(Button, makeProps('s-9'))
  findButton(button.tree).props.onClick()
  await tick()
  check(requests.length === 0, 'G: no request before serialization settles')
  // The composer moves to another Session (this component unmounts). The rewrite belongs to
  // s-9, so it must still go out — and its result must not be written while s-9 is away.
  unmount(button)
  gate.resolve({ attachments: [imageEntry('QUJD')] })
  await tick()
  await tick()
  check(requests.length === 1, 'G: a switched-away Session keeps its in-flight rewrite, got ' + requests.length)
  check(requests[0].body.sessionId === 's-9', 'G: the request still targets the originating Session')
  check(requests[0].body.attachments.length === 1, 'G: the attachments are still sent')
  requests[0].resolve(jsonResponse({ ok: true, text: '改写完成', model: 'm' }))
  await tick()
  await tick()
  check(!writes.includes('改写完成'), 'G: nothing is written while that Session is not open')
}

//#region H: the user's dock is never mutated
{
  reset()
  attachmentIds = ['a', 'b']
  serializeImpl = async () => ({ attachments: [imageEntry('QUJD', 'a.png'), { type: 'file', receiptId: 'r' }] })
  const button = mount(Button, makeProps('s-8'))
  findButton(button.tree).props.onClick()
  await tick()
  requests[0].resolve(jsonResponse({ ok: true, text: 'done', model: 'm' }))
  await tick()
  check(findButton(button.tree).props['data-phase'] === 'done', 'H: the write moved the control to the undo state, got ' + findButton(button.tree).props['data-phase'])
  findButton(button.tree).props.onClick() // undo
  await tick()
  check(mutatorCalls.length === 0, 'H: no conversation mutator called (' + MUTATORS.join(', ') + ')')
  check(otherInputCalls.length === 0, 'H: no InputActions mutator called')
  check(JSON.stringify(writes) === JSON.stringify(['done', '把这段提示词改好']), 'H: only setDraft was used (rewrite + undo), got ' + JSON.stringify(writes))
  check(attachmentIds.length === 2, 'H: attachment ids untouched by the rewrite')
  unmount(button)
}
//#endregion

// Leave no request dangling: a Session that is switched away from no longer aborts its
// in-flight work, so an unresolved fake request would keep the plugin's timeout timer (and
// therefore this process) alive. Settle everything before reporting.
for (const request of requests) {
  if (request.settled !== true) request.reject(Object.assign(new Error('harness cleanup'), { name: 'AbortError' }))
}
await tick()
const failed = results.filter(([ok]) => !ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
if (failed.length > 0) process.exitCode = 1