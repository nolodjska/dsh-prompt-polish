/**
 * Geometry test harness: proves the skeleton veil follows the
 * composer editor's CURRENT rect instead of a fixed 2–4 bar block.
 *
 * It emulates the host composer with a fake DOM:
 *   card  [data-composer-card]      (position:relative)
 *   anchor[data-composer-overlay]   (zero-height strip at the card top)
 *   editor[data-composer-input]     (the text area; top/height are the values under test)
 * plus an attachment rail that pushes the editor down.
 */
let captured = null
const windowListeners = new Map()
globalThis.window = {
  __ModuleLoader__: { load(spec) { captured = spec } },
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) {
    windowListeners.get(type)?.delete(fn)
  },
}
const fireWindow = (type) => {
  for (const fn of Array.from(windowListeners.get(type) ?? [])) fn()
}

//#region fake composer DOM
/**
 * The host composer under test.
 * - `editorTop`/`editorHeight`: the Lexical root's own rect (content height, unbounded).
 * - `scrollTop`/`visibleHeight`: the composer's scrollport
 *   (`.GRgSLq_scroll{max-height:…;overflow-y:auto}`), which clips that content.
 *   Both default to the editor's own values, i.e. "nothing is clipped".
 * - `cardHeight`: the painted surface's height; defaults to a card that wraps the editor.
 */
const composer = { editorTop: 116, editorHeight: 330, railCount: 3, scrollTop: null, visibleHeight: null, cardHeight: null }

const rect = (top, height) => ({ top, height, bottom: top + height, left: 0, right: 100, width: 100, x: 0, y: top })

const editorNode = {
  getBoundingClientRect: () => rect(composer.editorTop, composer.editorHeight),
}
const cardNode = {
  getBoundingClientRect: () => rect(0, composer.cardHeight ?? composer.editorTop + composer.editorHeight + 60),
  querySelector: (selector) => (selector === '[data-composer-input]' ? (composer.editorHeight > 0 ? editorNode : null) : null),
}
/** The anchor sits at the card's top edge (height 0), exactly like the shipped CSS. */
const anchorNode = {
  getBoundingClientRect: () => rect(0, 0),
  closest: (selector) => (selector === '[data-composer-card]' ? cardNode : null),
}
/** The veil node itself: only `closest` matters for measurement. */
const veilNode = {
  getBoundingClientRect: () => rect(0, 0),
  closest: (selector) => (selector === '[data-composer-overlay]' ? anchorNode : null),
  parentElement: anchorNode,
}
/** The composer's scrollport: the clipping ancestor between the editor and the card. */
const scrollNode = {
  getBoundingClientRect: () => rect(
    composer.scrollTop ?? composer.editorTop,
    composer.visibleHeight ?? composer.editorHeight,
  ),
}
/** `.GRgSLq_grow` — a plain positioned wrapper that clips nothing. */
const growNode = {
  getBoundingClientRect: () => rect(composer.editorTop, composer.editorHeight),
}
// editor → grow → scrollport (clips) → card, the shipped nesting order
editorNode.parentElement = growNode
growNode.parentElement = scrollNode
scrollNode.parentElement = cardNode
//#endregion

//#region fake ResizeObserver
const observers = []
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = new Set()
    this.disconnected = false
    observers.push(this)
  }
  observe(target) {
    if (this.disconnected) throw new Error('observe after disconnect')
    this.targets.add(target)
  }
  unobserve(target) {
    this.targets.delete(target)
  }
  disconnect() {
    this.disconnected = true
    this.targets.clear()
  }
  /**
   * Simulate a layout change: every live observer that watches one of the changed
   * nodes (or nothing in particular) re-runs its callback.
   */
  static notify(changed) {
    for (const observer of observers) {
      if (observer.disconnected) continue
      if (changed === undefined || observer.targets.has(changed)) observer.callback([{ target: changed }])
    }
  }
}
globalThis.ResizeObserver = FakeResizeObserver
const liveObservers = () => observers.filter((o) => !o.disconnected)
//#endregion

//#region mini react (with useLayoutEffect + ref attachment)
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
function useEffect(run, deps) {
  const inst = currentInstance
  const i = hookIndex++
  let slot = inst.hooks[i]
  if (slot === undefined) {
    slot = { deps: null, cleanup: undefined }
    inst.hooks[i] = slot
  }
  const changed = deps === undefined || slot.deps === null || !sameDeps(slot.deps, deps)
  if (deps !== undefined) slot.deps = [...deps]
  if (changed) inst.pending.push({ slot, fn: run })
}
const React = {
  Fragment,
  createElement,
  useState,
  useRef,
  useEffect,
  useLayoutEffect: useEffect,
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}
const requireStub = (name) => {
  if (name !== 'react') throw new Error('forbidden require: ' + name)
  return React
}
/** Attach fake host nodes to `ref` props so the component can measure them. */
function attachRefs(tree) {
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.el !== true) return
    const ref = node.props.ref
    if (ref !== null && typeof ref === 'object' && 'current' in ref) {
      ref.current = node.props.className === 'pp-skeleton' ? veilNode : null
    }
    node.children.forEach(walk)
  }
  walk(tree)
}
function renderInstance(inst) {
  const prev = currentInstance
  currentInstance = inst
  hookIndex = 0
  try {
    inst.tree = inst.Component(inst.props)
    attachRefs(inst.tree)
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
const findVeil = (tree) => findAll(tree, (n) => n.type === 'div' && n.props.className === 'pp-skeleton')[0]
const barsOf = (tree) => {
  const veil = findVeil(tree)
  return veil === undefined ? [] : findAll(veil, (n) => n.type === 'span' && n.props.className === 'pp-bar')
}
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
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get: () => undefined,
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

const Button = registered.find((r) => r.options.name === 'conversation.input.activity').component
const Skeleton = registered.find((r) => r.options.name === 'conversation.input.overlay').component

let draft = '第一行\n第二行\n第三行'
const attachmentIds = []
const setDraftExternal = (text) => {
  draft = text
  for (const inst of instances) inst.dirty = true
  flush()
}
/** Click the polish button and keep the request pending so the skeleton stays mounted. */
let pending = []
globalThis.fetch = (url, init) => {
  const request = { url, init }
  pending.push(request)
  return new Promise((resolve, reject) => {
    request.resolve = resolve
    request.reject = reject
    init.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
}
const makeProps = (sessionId) => ({
  sessionId,
  inputActions: { setDraft: (text) => setDraftExternal(text) },
  useInput: (select) => select({ draft, attachmentIds }),
  t: (key) => dict['prompt-polish'].zh[key] ?? key,
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const results = []
const check = (cond, msg) => {
  results.push([Boolean(cond), msg])
  console.log((cond ? 'ok  - ' : 'FAIL- ') + msg)
}
const px = (value) => Number(String(value ?? '').replace('px', ''))
const veilGeometry = (tree) => {
  const veil = findVeil(tree)
  if (veil === undefined) return null
  return { top: px(veil.props.style?.top), height: px(veil.props.style?.height), measured: veil.props['data-measured'] }
}
//#endregion

//#region scenarios
const button = mount(Button, makeProps('s-1'))
const skeleton = mount(Skeleton, makeProps('s-1'))

// idle: nothing rendered, no observers registered
check(findVeil(skeleton.tree) === undefined, 'idle: no veil')
check(composer.editorHeight === 330 && composer.editorTop === 116, 'scenario: 3-row attachment rail pushes the editor to top=116')

// pending: the veil must cover the whole 330px editor, offset by the rail above it
findButton(button.tree).props.onClick()
flush()
let veil = findVeil(skeleton.tree)
check(veil !== undefined, 'pending: veil mounted')
let geometry = veilGeometry(skeleton.tree)
check(geometry !== null && geometry.measured === 'true', 'pending: geometry comes from a real measurement')
check(geometry.top === 116, 'pending: top follows the editor offset below the attachment rail, got ' + geometry.top)
check(geometry.height === 330, 'pending: height covers the whole editor, got ' + geometry.height)
let bars = barsOf(skeleton.tree)
check(bars.length === Math.round(330 / 24), 'pending: bar count derives from the measured height, got ' + bars.length)
check(bars.length >= 13 && bars.length <= 14, 'pending: 330px → 13-14 bars on the 24px pitch')
const pct = (value) => Number(String(value ?? '').replace('%', ''))
const widths = bars.map((b) => pct(b.props.style.width))
check(widths[widths.length - 1] < widths[widths.length - 2], 'pending: last bar is shorter than the one above it')
check(new Set(widths.slice(0, -1)).size >= 3, 'pending: widths vary in a pattern, got ' + new Set(widths.slice(0, -1)).size + ' distinct')
check(veil.props['aria-hidden'] === 'true', 'pending: veil aria-hidden')
const styleNode = findAll(skeleton.tree, (n) => n.type === 'style')[0]
check(styleNode !== undefined, 'pending: styles ship with the component')
const css = String(textOf(styleNode))
check(css.includes('pointer-events:none'), 'pending: veil is click-through')
check(css.includes('--dsw-specific-input-major') && css.includes('color-mix'), 'pending: opaque surface with a color-mix fallback')
check(css.includes('transition:top .18s ease,height .18s ease'), 'pending: top/height transition')
check(css.includes('prefers-reduced-motion') && css.includes('.pp-skeleton{transition:none}'), 'pending: static under reduced motion')
check(css.includes('height:10px') && css.includes('gap:14px'), 'pending: 10px bar on the 24px pitch')

// the veil must be observed for editor AND card resizes, plus window resize
const watching = liveObservers()
check(watching.length === 1, 'live: exactly one ResizeObserver, got ' + watching.length)
check(watching[0].targets.has(editorNode), 'live: observes the editor')
check(watching[0].targets.has(cardNode), 'live: observes the card')
check((windowListeners.get('resize')?.size ?? 0) === 1, 'live: one window resize listener')

// growth: 330 -> 520 while typing, pushed by another rail row
composer.editorHeight = 520
composer.editorTop = 148
FakeResizeObserver.notify(editorNode)
flush()
geometry = veilGeometry(skeleton.tree)
check(geometry.height === 520, 'growth: veil grows with the editor, got ' + geometry.height)
check(geometry.top === 148, 'growth: veil top follows the new editor offset, got ' + geometry.top)
bars = barsOf(skeleton.tree)
check(bars.length === Math.round(520 / 24), 'growth: bar count follows the new height, got ' + bars.length)

// shrink back, via the card observer this time
composer.editorHeight = 96
composer.editorTop = 40
FakeResizeObserver.notify(cardNode)
flush()
geometry = veilGeometry(skeleton.tree)
check(geometry.height === 96 && geometry.top === 40, 'shrink: veil follows the card resize, got ' + JSON.stringify(geometry))
check(barsOf(skeleton.tree).length === 4, 'shrink: 96px → 4 bars, got ' + barsOf(skeleton.tree).length)
check(barsOf(skeleton.tree).length >= 1, 'shrink: still at least one bar')

// window resize re-measures too
composer.editorHeight = 240
composer.editorTop = 60
fireWindow('resize')
flush()
check(veilGeometry(skeleton.tree).height === 240, 'window resize: re-measures, got ' + veilGeometry(skeleton.tree).height)

// a pathological measurement cannot paint a wall of bars
composer.editorHeight = 5000
FakeResizeObserver.notify(editorNode)
flush()
check(barsOf(skeleton.tree).length === 40, 'clamp: bar count capped at 40, got ' + barsOf(skeleton.tree).length)
check(veilGeometry(skeleton.tree).height === 5000, 'clamp: the veil still covers the real editor height')

// CLIPPING: a tall draft lives inside the composer scrollport
// (`.GRgSLq_scroll{max-height:var(--dsh-composer-text-max-height);overflow-y:auto}`), so the
// Lexical root measures its whole CONTENT height while only `visibleHeight` is on screen.
// The veil must stop at the visible box, or it paints over the tool row and past the card edge.
composer.editorHeight = 900
composer.editorTop = 116
composer.visibleHeight = 300
FakeResizeObserver.notify(editorNode)
flush()
geometry = veilGeometry(skeleton.tree)
check(geometry.height === 300, 'clip: veil stops at the scrollport, got ' + geometry.height)
check(geometry.top === 116, 'clip: top still starts at the editor, got ' + geometry.top)
bars = barsOf(skeleton.tree)
check(bars.length === 13, 'clip: 300px visible → 13 bars, got ' + bars.length)
check(bars.length * 10 + (bars.length - 1) * 14 <= 300, 'clip: bars fit inside the veil, got ' + (bars.length * 10 + (bars.length - 1) * 14))

// scrolled: the editor's top is above the scrollport, so the veil must not paint above it
composer.editorTop = 46
composer.scrollTop = 116
FakeResizeObserver.notify(editorNode)
flush()
geometry = veilGeometry(skeleton.tree)
check(geometry.top === 116, 'clip: a scrolled editor never paints above the scrollport, got ' + geometry.top)
check(geometry.height === 300, 'clip: height still the visible box, got ' + geometry.height)

// the card is the painted surface: a measurement that somehow exceeds it is still capped
composer.scrollTop = null
composer.visibleHeight = null
composer.editorTop = 100
composer.editorHeight = 200
composer.cardHeight = 250
FakeResizeObserver.notify(editorNode)
flush()
geometry = veilGeometry(skeleton.tree)
check(geometry.height === 150, 'clip: never extends past the card, got ' + geometry.height)
composer.cardHeight = null
composer.visibleHeight = null
composer.scrollTop = null

// completing the request removes the veil and releases every observer/listener
pending[pending.length - 1].resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, text: '改写完成', model: 'm' }) })
await tick()
flush()
check(findVeil(skeleton.tree) === undefined, 'done: veil unmounted')
check(liveObservers().length === 0, 'done: ResizeObserver disconnected, live=' + liveObservers().length)
check((windowListeners.get('resize')?.size ?? 0) === 0, 'done: window resize listener removed')

// fallback: an unmeasurable editor falls back to the draft estimate
const editorlessSkeleton = mount(Skeleton, makeProps('s-2'))
const editorlessButton = mount(Button, makeProps('s-2'))
const realHeight = composer.editorHeight
composer.editorHeight = 0 // editor rect unavailable
setDraftExternal('短草稿')
findButton(editorlessButton.tree).props.onClick()
flush()
geometry = veilGeometry(editorlessSkeleton.tree)
check(geometry !== null && geometry.measured === 'false', 'fallback: unmeasurable editor falls back to the estimate')
check(geometry.height === 48 && geometry.top === 6, 'fallback: 2-line estimate (48px) at the legacy offset, got ' + JSON.stringify(geometry))
check(barsOf(editorlessSkeleton.tree).length === 2, 'fallback: 48px → 2 bars')

// and a tall draft keeps a taller estimate
pending[pending.length - 1].resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, text: 'x', model: 'm' }) })
await tick()
flush()
setDraftExternal(Array.from({ length: 9 }, (_v, i) => '第' + i + '行内容').join('\n'))
flush()
findButton(editorlessButton.tree).props.onClick()
flush()
geometry = veilGeometry(editorlessSkeleton.tree)
check(geometry.measured === 'false' && geometry.height === 9 * 24, 'fallback: 9 draft lines estimate 216px, got ' + geometry.height)
composer.editorHeight = realHeight

// a throwing measurement never breaks rendering
const realQuery = cardNode.querySelector
cardNode.querySelector = () => {
  throw new Error('detached node')
}
setDraftExternal('抛错场景')
findButton(editorlessButton.tree).props.onClick()
flush()
check(findVeil(editorlessSkeleton.tree) !== undefined, 'defensive: a throwing measurement still renders the veil')
const thrownGeometry = veilGeometry(editorlessSkeleton.tree)
check(thrownGeometry.measured === 'false' && thrownGeometry.height > 0, 'defensive: falls back after the throw, got ' + JSON.stringify(thrownGeometry))
cardNode.querySelector = realQuery
//#endregion

const failed = results.filter(([ok]) => !ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
if (failed.length > 0) process.exitCode = 1
