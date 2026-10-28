/**
 * Load/registration smoke test: loads the client bundle with a
 * stubbed window.__ModuleLoader__ / React / ctx and asserts the registration
 * surface, locale dictionaries and store wiring. No DOM, no rendering.
 */
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec
    },
  },
}

function fakeReact() {
  const Fragment = Symbol('Fragment')
  return {
    Fragment,
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
}

const req = (name) => {
  if (name !== 'react') throw new Error('forbidden require: ' + name)
  return fakeReact()
}

await import(new URL('../client.js', import.meta.url).href)

const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const ok = (cond, msg) => (cond ? console.log('ok  -', msg) : fail(msg))

ok(captured !== null, 'loader received a module')
ok(captured.id === '@local/prompt-polish', 'id is @local/prompt-polish')
ok(typeof captured.factory === 'function', 'factory is a function')

const plugin = captured.factory(req)
ok(Array.isArray(plugin.inject), 'plugin.inject is an array')
ok(plugin.inject.includes('slots') && plugin.inject.includes('locale'), 'inject: slots + locale')
ok(typeof plugin.apply === 'function', 'apply is a function')

const effects = []
const registrations = []
const dictionary = {}
const ctx = {
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register(ns, dict) {
      dictionary[ns] = dict
      return () => {}
    },
    bind(ns) {
      return (key) => (dictionary[ns]?.zh?.[key] ?? key)
    },
  },
  slots: {
    inject(slotName, factory) {
      const dispose = factory()
      registrations.push({ slotName, dispose })
      return () => {}
    },
    register(options) {
      registrations.push({ options })
      return () => {}
    },
  },
}

plugin.apply(ctx)

ok(effects.length === 2, 'apply owns 2 ctx.effect resources, got ' + effects.length)
const registered = registrations.filter((r) => r.options !== undefined)
ok(registered.length === 2, 'two slot registrations, got ' + registered.length)

const activity = registered.find((r) => r.options.name === 'conversation.input.activity')
const overlay = registered.find((r) => r.options.name === 'conversation.input.overlay')
ok(activity !== undefined, 'registers conversation.input.activity')
ok(overlay !== undefined, 'registers conversation.input.overlay')
ok(overlay !== undefined && overlay.options.id === 'prompt-polish-skeleton', 'overlay id prompt-polish-skeleton')
ok(overlay !== undefined && overlay.options.order === 50, 'overlay order 50')
ok(activity !== undefined && typeof activity.options.locale === 'string', 'activity declares locale ns')
ok(activity !== undefined && activity.options.children === undefined, 'activity declares no children (never expands)')

const dict = dictionary['prompt-polish']
ok(dict !== undefined, 'locale namespace prompt-polish registered')
const zhKeys = Object.keys(dict?.zh ?? {}).sort()
const enKeys = Object.keys(dict?.en ?? {}).sort()
ok(zhKeys.length > 0 && JSON.stringify(zhKeys) === JSON.stringify(enKeys), 'zh and en key sets match')
for (const key of ['button.polish', 'button.pending', 'button.undo', 'error.network', 'error.timeout', 'error.generic']) {
  ok(zhKeys.includes(key), 'dictionary has ' + key)
}

// factory must be side-effect free: nothing above should have touched the ctx
// before apply(); re-invoking the factory must not throw either.
const second = captured.factory(req)
ok(second.inject.includes('slots'), 'factory is re-entrant (no top-level side effects)')

console.log('\ndone; exitCode =', process.exitCode ?? 0)
