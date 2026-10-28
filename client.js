/**
 * prompt-polish — browser half.
 *
 * Adds one compact control to the composer tool row (immediately after the
 * model selector), plus a shimmer skeleton that plays inside the resident
 * composer card while a rewrite is running.
 *
 * Slots (child slots of `conversation.composer.bar`, declared by the shipped
 * conversation UI package):
 *   - conversation.input.activity (single, session) -> PolishButton
 *   - conversation.input.overlay  (list,   session) -> PolishSkeleton (id prompt-polish-skeleton, order 50)
 *
 * The composer overlay outlet is a zero-height absolutely positioned strip at the
 * top of the composer card (`.GRgSLq_overlayAnchor{height:0;position:absolute;inset:0 0 auto}`
 * inside `.GRgSLq_card{position:relative}`), so the skeleton anchors from the card top
 * and paints above the editor (z-index:1). It measures the Lexical root
 * (`[data-composer-input]`) to cover the editor's CURRENT rect — top and height — so
 * the veil tracks a draft that grows, shrinks, or sits under an attachment rail.
 */
window.__ModuleLoader__.load({
  id: '@local/prompt-polish',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'prompt-polish'
    const ROUTE = '/api/prompt-polish/optimize'
    const TIMEOUT_MS = 90000
    /** Images must be encoded, uploaded and inspected by a vision model, so they get a longer budget. */
    const TIMEOUT_MS_WITH_IMAGES = 120000
    const ERROR_TTL_MS = 6000
    /** Composer line rhythm: bars are spaced one editor line apart (10px bar + 14px gap). */
    const SKELETON_BAR_PITCH = 24
    /** Ceiling for the derived bar count / veil height, so a pathological measurement cannot paint a wall. */
    const SKELETON_MAX_BARS = 40
    /** Repeating width pattern (percent) so a tall veil does not look like a ladder of identical bars. */
    const SKELETON_BAR_PATTERN = [96, 72, 88, 60, 92, 78, 84, 66]
    /** Candidate widths for the final bar, which always ends shorter than the one above it. */
    const SKELETON_LAST_WIDTHS = [58, 46, 64, 52]
    /** Fallback veil offset from the anchor when the editor cannot be measured (today's geometry). */
    const SKELETON_FALLBACK_TOP = 6
    /** Host hooks: the composer card, the overlay anchor we render into, and the Lexical root. */
    const COMPOSER_CARD_SELECTOR = '[data-composer-card]'
    const COMPOSER_OVERLAY_SELECTOR = '[data-composer-overlay]'
    const COMPOSER_INPUT_SELECTOR = '[data-composer-input]'

    /** At most this many draft attachments ride along with one rewrite. */
    const MAX_ATTACHMENTS = 8
    /** Per-image base64 ceiling (characters): ≈ 6 MB decoded, above the composer's own intake limits. */
    const MAX_IMAGE_ENCODED_CHARS = 8400000
    /** Whole-payload encoded ceiling (characters): ≈ 24 MB decoded across every attached image. */
    const MAX_TOTAL_ENCODED_CHARS = 32000000
    /** Wire media types the composer's own encoder can produce. */
    const WIRE_IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

    /** @type {ReturnType<typeof createPolishStore> | null} */
    let store = null
    /** @type {((key: string) => string) | null} */
    let boundT = null
    /**
     * The plugin context, kept only so the click path can resolve the ambient
     * `conversation` service lazily (`ctx.get('conversation')`): that service belongs
     * to another package and may activate after this one.
     * @type {object | null}
     */
    let pluginCtx = null

    //#region store
    /**
     * One immutable state per session id, shared by the toolbar button and the
     * composer overlay (they are separate slot entries). Owned by `apply` via
     * ctx.effect, which aborts every in-flight request on unload.
     *
     * state = { phase: 'idle', error: string | null }
     *       | { phase: 'pending', token, controller, original, error: null }
     *       | { phase: 'done', original, written, error: null }
     */
    function createPolishStore() {
      const IDLE = Object.freeze({ phase: 'idle', error: null, original: null, written: null })
      const entries = new Map()
      const listeners = new Set()
      let seq = 0
      let disposed = false

      const read = (sessionId) => (sessionId === undefined ? IDLE : entries.get(sessionId) ?? IDLE)
      const notify = () => {
        if (disposed) return
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            console.error('[prompt-polish] state listener failed:', error)
          }
        }
      }
      const current = (sessionId, token) => {
        const state = read(sessionId)
        return state.phase === 'pending' && state.token === token ? state : null
      }
      const drop = (sessionId) => {
        if (sessionId === undefined || !entries.has(sessionId)) return
        entries.delete(sessionId)
        notify()
      }
      const abortOf = (state) => {
        if (state.phase === 'pending' && state.controller !== null) {
          try {
            state.controller.abort()
          } catch (_error) {
            /* already settled */
          }
        }
      }

      return {
        get: read,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** Start a rewrite; returns the pending entry (null when one is already live). */
        begin(sessionId, draft) {
          if (disposed || sessionId === undefined) return null
          const live = read(sessionId)
          if (live.phase !== 'idle') return null
          seq += 1
          const entry = {
            phase: 'pending',
            error: null,
            original: draft,
            written: null,
            token: seq,
            controller: new AbortController(),
          }
          entries.set(sessionId, entry)
          notify()
          return entry
        },
        isCurrent(sessionId, token) {
          return current(sessionId, token) !== null
        },
        /** Rewrite landed: remember what we replaced and what we wrote. */
        succeed(sessionId, token, written) {
          const live = current(sessionId, token)
          if (live === null) return false
          entries.set(sessionId, {
            phase: 'done',
            error: null,
            original: live.original,
            written,
            token,
            controller: null,
            // The draft is written by the component of the Session that owns this entry,
            // once it renders — which may be later, if the user switched away meanwhile.
            applied: false,
          })
          notify()
          return true
        },
        /** Mark the completed rewrite as written into its Session's draft. */
        markApplied(sessionId) {
          const live = read(sessionId)
          if (live.phase !== 'done' || live.applied === true) return false
          entries.set(sessionId, { ...live, applied: true })
          notify()
          return true
        },
        /** Rewrite failed: keep the draft untouched, surface one short message. */
        fail(sessionId, token, message) {
          const live = current(sessionId, token)
          if (live === null) return false
          entries.set(sessionId, { phase: 'idle', error: message, original: null, written: null })
          notify()
          return true
        },
        clearError(sessionId) {
          const live = read(sessionId)
          if (live.phase !== 'idle' || live.error === null) return
          drop(sessionId)
        },
        /** Back to idle (undo consumed, user edited the rewritten text, or send). */
        dismiss(sessionId) {
          abortOf(read(sessionId))
          drop(sessionId)
        },
        /**
         * The Session this entry belongs to is gone (closed, deleted, no longer in the
         * catalog): drop it silently. No abort signal reaches the user, no error is
         * surfaced, and no other Session's entry is touched.
         */
        discard(sessionId) {
          abortOf(read(sessionId))
          drop(sessionId)
        },
        dispose() {
          disposed = true
          for (const state of entries.values()) abortOf(state)
          entries.clear()
          listeners.clear()
        },
      }
    }
    //#endregion

    //#region hooks
    /** The store is null only between plugin disposal and component unmount. */
    const IDLE_STATE = Object.freeze({ phase: 'idle', error: null, original: null, written: null })

    /** Subscribe to the per-session polish state (stable object identity while unchanged). */
    function usePolishState(sessionId) {
      const [snapshot, setSnapshot] = React.useState(() =>
        store === null ? IDLE_STATE : store.get(sessionId),
      )
      React.useEffect(() => {
        let alive = true
        if (store === null) return () => {}
        setSnapshot(store.get(sessionId))
        const off = store.subscribe(() => {
          if (alive && store !== null) setSnapshot(store.get(sessionId))
        })
        return () => {
          alive = false
          off()
        }
      }, [sessionId])
      return snapshot
    }

    function useTranslate(props) {
      return typeof props.t === 'function' ? props.t : boundT
    }
    //#endregion

    //#region attachments
    /** Stable empty lists, so a click with no attachments allocates nothing. */
    const NO_ATTACHMENT_IDS = Object.freeze([])
    const NO_ATTACHMENTS = Object.freeze([])

    /**
     * Read the draft's attachment ids from the published `InputState`
     * (`{ draft, attachmentIds, draftRev, phase, claim?, occurrences, queue }`).
     * These are browser-local, draft-scoped ids, not durable attachment ids.
     * @param {unknown} value the selected `InputState.attachmentIds`.
     * @returns {readonly string[]} usable ids in rail order (empty when none).
     */
    function readAttachmentIds(value) {
      if (!Array.isArray(value) || value.length === 0) return NO_ATTACHMENT_IDS
      const ids = []
      for (const id of value) if (typeof id === 'string' && id !== '') ids.push(id)
      return ids.length === 0 ? NO_ATTACHMENT_IDS : ids
    }

    /**
     * Whether a Session is still present in the client's Session catalog.
     *
     * Used only to decide whether a finished rewrite may still be written: a Session the
     * user closed or deleted must drop its result silently instead of surfacing an error.
     * Deliberately conservative — an unavailable or not-yet-populated catalog counts as
     * "alive", because refusing to write a good result is worse than writing one.
     *
     * @param {unknown} snapshot the `useSessions` snapshot (`{ byId: {...} }`).
     * @param {unknown} id the Session id the result belongs to.
     * @returns {boolean} false only when the catalog is populated and the id is missing.
     */
    function isSessionAlive(snapshot, id) {
      if (typeof id !== 'string' || id === '') return false
      if (snapshot === null || typeof snapshot !== 'object') return true
      const byId = snapshot.byId
      if (byId === null || typeof byId !== 'object') return true
      if (Object.keys(byId).length === 0) return true
      return byId[id] !== undefined
    }

    /**
     * Apply the size caps to already-serialized attachments. Anything dropped here is
     * simply not sent; the user's dock keeps every attachment regardless.
     * @param {readonly unknown[]} list serialized wire payloads in rail order.
     * @returns {readonly object[]} the payloads that may be sent.
     */
    function capPolishAttachments(list) {
      const out = []
      let total = 0
      for (const item of list) {
        if (out.length >= MAX_ATTACHMENTS) break
        if (item === null || typeof item !== 'object') continue
        if (item.type === 'image') {
          const data = typeof item.data === 'string' ? item.data : ''
          if (data === '' || data.length > MAX_IMAGE_ENCODED_CHARS) continue
          if (total + data.length > MAX_TOTAL_ENCODED_CHARS) break
          total += data.length
          const mediaType = WIRE_IMAGE_MEDIA_TYPES.has(item.mediaType) ? item.mediaType : 'image/png'
          const entry = { type: 'image', mediaType, data }
          if (typeof item.name === 'string' && item.name !== '') entry.name = item.name
          out.push(entry)
          continue
        }
        if (item.type === 'file') {
          const receiptId = typeof item.receiptId === 'string' ? item.receiptId : ''
          if (receiptId === '') continue
          if (total + receiptId.length > MAX_TOTAL_ENCODED_CHARS) break
          total += receiptId.length
          const entry = { type: 'file', receiptId }
          if (typeof item.name === 'string' && item.name !== '') entry.name = item.name
          if (typeof item.bytes === 'number' && Number.isFinite(item.bytes) && item.bytes >= 0) entry.bytes = item.bytes
          out.push(entry)
        }
      }
      return out.length === 0 ? NO_ATTACHMENTS : out
    }

    /**
     * Resolve the composer's docked draft attachments into the documented wire payloads.
     *
     * READ-ONLY BY DESIGN — the dock belongs to the user. This module never calls
     * `releaseDraftAttachment`, `releaseDraftAttachments`, `removeAttachment`,
     * `pruneAttachments`, `addAttachments`, or anything else that mutates the composer's
     * draft attachments: a rewrite is a read of the user's context, so every attachment
     * stays docked, keeps its order, and keeps its upload running.
     * `serializeDraftAttachments` is the one call used because it only encodes images and
     * cites already-finished upload receipts, without sending or releasing anything.
     *
     * BEST-EFFORT — the rewrite must never be blocked by an attachment problem. Ids that
     * went away, a file whose upload is still running (that call is all-or-nothing), an
     * unsupported media type, or a Host build without the service all degrade to "no
     * attachments"; the failure is logged for diagnosis and never shown to the user.
     *
     * @param {readonly string[]} ids draft-local attachment ids in rail order.
     * @returns {Promise<readonly object[]>} sendable payloads, never a rejection.
     */
    async function resolvePolishAttachments(ids) {
      if (ids.length === 0) return NO_ATTACHMENTS
      try {
        const ctx = pluginCtx
        const conversation = ctx === null || typeof ctx.get !== 'function' ? undefined : ctx.get('conversation')
        if (conversation === null || conversation === undefined) return NO_ATTACHMENTS
        if (typeof conversation.serializeDraftAttachments !== 'function') return NO_ATTACHMENTS
        const serialized = await conversation.serializeDraftAttachments(ids)
        const list = Array.isArray(serialized)
          ? serialized
          : Array.isArray(serialized?.attachments) ? serialized.attachments : NO_ATTACHMENTS
        return capPolishAttachments(list)
      } catch (error) {
        console.error('[prompt-polish] draft attachments are unavailable for this rewrite; continuing without them:', error)
        return NO_ATTACHMENTS
      }
    }
    //#endregion

    //#region styles
    const BUTTON_CSS = `
.pp-root{display:inline-flex;align-items:center;gap:8px;min-width:0}
.pp-wrap{display:inline-flex;flex:none}
.pp-btn{box-sizing:border-box;width:28px;height:28px;flex:none;display:grid;place-items:center;padding:0;margin:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s ease,color .12s ease,opacity .12s ease}
.pp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pp-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.pp-btn:focus{outline:none}
.pp-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.pp-btn:disabled{opacity:.45;cursor:default}
.pp-btn[data-phase="done"]{color:var(--dsw-alias-state-business-primary)}
.pp-btn[data-phase="done"]:hover:not(:disabled){color:var(--dsw-alias-state-business-primary)}
.pp-icon{display:block;pointer-events:none}
.pp-spin{animation:pp-spin 1s linear infinite;transform-origin:50% 50%}
@keyframes pp-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.pp-error{font:inherit;font-size:12px;line-height:18px;max-width:190px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-state-error-primary);opacity:.9}
@media (prefers-reduced-motion: reduce){.pp-spin{animation:none}}
`

    const SKELETON_CSS = `
.pp-skeleton{position:absolute;z-index:1;left:14px;right:10px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-start;gap:14px;padding:4px 0;overflow:hidden;border-radius:var(--dsw-radius-sm,6px);pointer-events:none;cursor:default;user-select:none;transition:top .18s ease,height .18s ease;
background:#1f1f22;
background:var(--dsw-specific-input-major,#1f1f22);
background:color-mix(in srgb,var(--dsw-specific-input-major,#1f1f22) 94%,var(--dsw-alias-bg-layer-1,#1f1f22))}
.pp-bar{flex:none;height:10px;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-interactive-bg-hover) 0%,var(--dsw-alias-interactive-bg-hover-solid) 50%,var(--dsw-alias-interactive-bg-hover) 100%);background-size:220% 100%;animation:pp-shimmer 1.3s ease-in-out infinite}
.pp-bar:nth-child(3n+2){animation-delay:.12s}
.pp-bar:nth-child(3n+3){animation-delay:.24s}
@keyframes pp-shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
@media (prefers-reduced-motion: reduce){.pp-skeleton{transition:none}.pp-bar{animation:none;background:var(--dsw-alias-interactive-bg-hover)}}
`
    //#endregion

    //#region components
    function PolishIcon({ phase }) {
      const common = {
        className: 'pp-icon',
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': 'true',
        focusable: 'false',
      }
      if (phase === 'pending') {
        return h(
          'svg',
          Object.assign({}, common, { className: 'pp-icon pp-spin' }),
          h('circle', {
            cx: 8,
            cy: 8,
            r: 5.6,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            opacity: 0.25,
          }),
          h('path', {
            d: 'M8 2.4a5.6 5.6 0 0 1 5.6 5.6',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
          }),
        )
      }
      if (phase === 'done') {
        return h(
          'svg',
          common,
          h('path', {
            d: 'M6.4 4.1 3.2 7.3l3.2 3.2',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
          h('path', {
            d: 'M3.4 7.3h5.9a3.3 3.3 0 0 1 0 6.6H6.7',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )
      }
      return h('svg', common, h('path', {
        d: 'M8 2.2 9.3 6.7 13.8 8 9.3 9.3 8 13.8 6.7 9.3 2.2 8 6.7 6.7Z',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinejoin: 'round',
      }))
    }

    /**
     * `conversation.input.activity` — a 28px icon control in the composer tool
     * row, right after the model selector and left of the send button.
     *
     * idle    : sparkle, enabled only for a non-blank draft
     * pending : disabled, spinning arc (`aria-busy`)
     * done    : undo affordance restoring the captured draft
     * error   : short inline message beside the control, back to idle
     */
    function PolishButton(props) {
      const t = useTranslate(props)
      const sessionId = props.sessionId
      const actions = props.inputActions
      const draftValue = props.useInput((state) => state.draft)
      const draft = typeof draftValue === 'string' ? draftValue : ''
      const attachmentIdsValue = props.useInput((state) => state.attachmentIds)
      const state = usePolishState(sessionId)
      const phase = state.phase
      const written = state.written

      const actionsRef = React.useRef(actions)
      actionsRef.current = actions

      // The Session catalog: used to prove the ORIGINATING Session still exists before
      // a result is written. Kept in a ref so the fetch closure can read the live
      // snapshot long after the render that started the request.
      const sessionsSnapshot = typeof props.useSessions === 'function' ? props.useSessions((snapshot) => snapshot) : undefined
      const sessionsRef = React.useRef(sessionsSnapshot)
      sessionsRef.current = sessionsSnapshot

      // While showing undo, only keep it while the composer still holds OUR
      // text. `seen` tolerates the frame between the store write and the
      // composer write, so the affordance never flickers away.
      //
      // Declared BEFORE the write effect on purpose: both effects can run in the same
      // commit, and this one must judge the draft as it was before our write — otherwise a
      // re-entrant re-render could make it believe the user had edited over us and drop a
      // freshly written result.
      const seen = React.useRef(false)
      React.useEffect(() => {
        if (phase !== 'done') {
          seen.current = false
          return
        }
        if (draft === written) {
          seen.current = true
          return
        }
        if (seen.current && store !== null) store.dismiss(sessionId)
      }, [phase, written, draft, sessionId])

      // Switching Sessions does NOT cancel anything: the request keeps running under the
      // entry of the Session that started it, and that Session's own component writes the
      // result whenever it is rendered again. Only plugin disposal aborts work.
      //
      // `appliedRef` guards the write synchronously: a render may be flushed from inside
      // this effect, and the same completed result must never be written twice.
      const applied = state.applied
      const appliedRef = React.useRef(null)
      React.useEffect(() => {
        if (phase !== 'done' || applied === true || store === null) return
        if (sessionId === undefined || typeof written !== 'string') return
        if (appliedRef.current === state.token) return
        appliedRef.current = state.token
        const latest = actionsRef.current
        if (latest !== null && latest !== undefined && typeof latest.setDraft === 'function') {
          // The composer now belongs to the Session that owns this result, so this writes
          // into the right draft — including the case where it finished while the user was
          // looking at another Session.
          latest.setDraft(written)
        }
        store.markApplied(sessionId)
      }, [phase, applied, written, sessionId])

      const error = state.error
      React.useEffect(() => {
        if (error === null) return
        const timer = setTimeout(() => {
          if (store !== null) store.clearError(sessionId)
        }, ERROR_TTL_MS)
        return () => clearTimeout(timer)
      }, [error, sessionId])

      const polishing = phase === 'pending'
      const undoable = phase === 'done'
      const blank = draft.trim() === ''
      const disabled = polishing || props.locked === true || (!undoable && (blank || sessionId === undefined))

      /**
       * Dispatch one rewrite with the attachment payload already resolved. Everything up
       * to the `fetch` runs synchronously, so a text-only click leaves in the same tick as
       * before; the timer budget follows the payload (images get more time).
       */
      const sendPolishRequest = async (started, promptText, attachments) => {
        const token = started.token
        const controller = started.controller
        let timedOut = false
        let timer
        const settle = () => {
          if (timer !== undefined) clearTimeout(timer)
          timer = undefined
        }
        const hasImages = attachments.some((item) => item.type === 'image')
        timer = setTimeout(() => {
          timedOut = true
          try {
            controller.abort()
          } catch (_error) {
            /* already settled */
          }
        }, hasImages ? TIMEOUT_MS_WITH_IMAGES : TIMEOUT_MS)

        const body = { sessionId, text: promptText }
        if (attachments.length > 0) body.attachments = attachments

        // Everything below belongs to the Session that STARTED this request, whichever
        // Session is open when it settles.
        const origin = sessionId
        const originAlive = () => isSessionAlive(sessionsRef.current, origin)

        let response
        let raw = ''
        try {
          response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          raw = await response.text()
        } catch (failure) {
          settle()
          if (store === null || !store.isCurrent(origin, token)) return
          if (!originAlive()) {
            // The Session was closed/deleted while the request ran: drop it silently.
            store.discard(origin)
            return
          }
          if (failure !== null && failure !== undefined && failure.name === 'AbortError') {
            if (timedOut) store.fail(origin, token, t('error.timeout'))
            else store.dismiss(origin)
            return
          }
          store.fail(origin, token, t('error.network'))
          return
        }
        settle()
        if (store === null || !store.isCurrent(origin, token)) return
        // A vanished Session never gets a state entry of its own, never writes a draft and
        // never shows an error: the result is simply discarded.
        if (!originAlive()) {
          store.discard(origin)
          return
        }
        let payload = null
        if (raw !== '') {
          try {
            payload = JSON.parse(raw)
          } catch (_error) {
            payload = null
          }
        }
        if (payload !== null && typeof payload === 'object' && payload.ok === false) {
          const message = typeof payload.message === 'string' && payload.message !== '' ? payload.message : t('error.generic')
          store.fail(origin, token, message)
          return
        }
        const text = payload !== null && typeof payload === 'object' && payload.ok === true && typeof payload.text === 'string' ? payload.text : ''
        if (!response.ok || text.trim() === '') {
          store.fail(origin, token, t('error.generic'))
          return
        }
        // Recorded against the origin Session. The write itself happens in that Session's
        // component effect, so it lands in the right draft even when the user is elsewhere
        // right now — and it lands exactly once.
        store.succeed(origin, token, text)
      }

      /**
       * Resolve the docked attachments first, then dispatch. With nothing to resolve this
       * issues the request synchronously; otherwise the store token and session are
       * re-checked after the await so a stale rewrite can never reach a draft.
       */
      const startPolish = async (started, promptText, ids) => {
        let attachments = NO_ATTACHMENTS
        if (ids.length > 0) {
          attachments = await resolvePolishAttachments(ids)
          // Full re-check after the await: the session may have changed, the request may
          // have been aborted, or the plugin may have been disposed meanwhile.
          if (store === null || !store.isCurrent(sessionId, started.token)) return
        }
        return sendPolishRequest(started, promptText, attachments)
      }

      const runPolish = () => {
        if (disabled || polishing || undoable || store === null) return
        const started = store.begin(sessionId, draft)
        if (started === null) return
        const { token } = started
        startPolish(started, draft, readAttachmentIds(attachmentIdsValue)).catch((failure) => {
          // Defensive: every inner path handles its own failure, so reaching this means a
          // bug. Settle the state instead of leaving a spinner running forever.
          console.error('[prompt-polish] rewrite dispatch failed:', failure)
          if (store !== null) store.fail(sessionId, token, t('error.generic'))
        })
      }

      const runUndo = () => {
        if (!undoable) return
        const original = state.original
        const latest = actionsRef.current
        if (latest !== null && latest !== undefined && typeof latest.setDraft === 'function') latest.setDraft(original)
        if (store !== null) store.dismiss(sessionId)
        seen.current = false
      }

      const label = polishing ? t('button.pending') : undoable ? t('button.undo') : t('button.polish')

      return h(
        React.Fragment,
        null,
        h('style', null, BUTTON_CSS),
        h(
          'div',
          { className: 'pp-root' },
          error === null ? null : h(
            'span',
            { className: 'pp-error', role: 'status', title: error },
            error,
          ),
          h(
            'span',
            { className: 'pp-wrap', title: label },
            h(
              'button',
              {
                type: 'button',
                className: 'pp-btn',
                'data-phase': phase,
                'aria-label': label,
                'aria-busy': polishing ? 'true' : undefined,
                disabled,
                onMouseDown: (event) => {
                  // Keep the composer's caret where the user left it.
                  event.preventDefault()
                },
                onClick: undoable ? runUndo : runPolish,
              },
              h(PolishIcon, { phase }),
            ),
          ),
        ),
      )
    }

    /** Layout timing when the shell provides it; a plain effect otherwise. */
    const useLayoutEffectSafe = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

    /**
     * Measure the composer's real text area against our own overlay anchor.
     *
     * MEASUREMENT ONLY: the bounding boxes of our own host composer are read, and
     * nothing is written — no host element is styled, injected or mutated, and the
     * editor is never touched. The Lexical root (`[data-composer-input]`) is the exact
     * text area, so measuring it gives the correct offset even when an attachment rail
     * or accessory row sits above it. Everything is wrapped: a shell that does not
     * expose these hooks (or throws on a detached node) simply yields `null`.
     *
     * CLAMPED TO THE VISIBLE BOX: the editor grows with the draft, but the composer
     * clips it inside a scrollport (`.GRgSLq_scroll{max-height:var(--dsh-composer-text-max-height);
     * overflow-y:auto}`). Its own rect is therefore often far TALLER than what the user
     * sees — a 40-line draft measures ~900px inside a ~300px window — so the veil must be
     * the visible intersection of the editor and every ancestor up to the card. Taking the
     * tightest enclosing box needs no hashed class name: an unclipped chain only reports
     * larger ancestors, which clamp nothing.
     *
     * @param {object | null} node our own rendered veil element.
     * @returns {{ top: number, height: number } | null} offset+height, or null when unmeasurable.
     */
    function measureComposerEditor(node) {
      try {
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return null
        const anchor = typeof node.closest === 'function'
          ? node.closest(COMPOSER_OVERLAY_SELECTOR) ?? node.parentElement ?? null
          : node.parentElement ?? null
        if (anchor === null || anchor === undefined || typeof anchor.getBoundingClientRect !== 'function') return null
        const card = typeof anchor.closest === 'function' ? anchor.closest(COMPOSER_CARD_SELECTOR) : null
        if (card === null || card === undefined || typeof card.querySelector !== 'function') return null
        const editor = card.querySelector(COMPOSER_INPUT_SELECTOR)
        if (editor === null || editor === undefined || typeof editor.getBoundingClientRect !== 'function') return null
        const editorRect = editor.getBoundingClientRect()
        const anchorRect = anchor.getBoundingClientRect()

        let top = editorRect.top
        let bottom = editorRect.bottom
        /** Keep the tightest box: the highest top and the lowest bottom win. */
        const clampTo = (rect) => {
          if (rect === null || rect === undefined) return
          if (Number.isFinite(rect.top) && Number.isFinite(top) && rect.top > top) top = rect.top
          if (Number.isFinite(rect.bottom) && Number.isFinite(bottom) && rect.bottom < bottom) bottom = rect.bottom
        }

        // Walk from the editor out to the card. The ancestor that actually clips (the
        // composer's scrollport) is always smaller than the unclipped editor box, so the
        // tightest box found on the way IS the visible text area.
        let current = editor.parentElement ?? null
        for (let depth = 0; current !== null && current !== undefined && depth < 32; depth += 1) {
          if (typeof current.getBoundingClientRect === 'function') clampTo(current.getBoundingClientRect())
          if (current === card) break
          current = current.parentElement ?? null
        }
        // The card is the painted surface: never extend past it, whatever the walk found.
        if (typeof card.getBoundingClientRect === 'function') clampTo(card.getBoundingClientRect())

        const height = Math.round(bottom - top)
        if (!Number.isFinite(height) || height <= 0) return null
        const rawTop = top - anchorRect.top
        const top_ = Number.isFinite(rawTop) ? Math.max(0, Math.round(rawTop)) : SKELETON_FALLBACK_TOP
        return { top: top_, height }
      } catch (error) {
        console.error('[prompt-polish] composer measurement failed:', error)
        return null
      }
    }

    /**
     * The editor node and the card it lives in, for resize observation.
     * @param {object | null} node our own rendered veil element.
     * @returns {{ editor: object | null, card: object | null }}
     */
    function composerMeasureTargets(node) {
      try {
        if (node === null || node === undefined || typeof node.closest !== 'function') return { editor: null, card: null }
        const anchor = node.closest(COMPOSER_OVERLAY_SELECTOR) ?? node.parentElement ?? null
        const card = anchor !== null && typeof anchor.closest === 'function' ? anchor.closest(COMPOSER_CARD_SELECTOR) : null
        const editor = card !== null && typeof card.querySelector === 'function' ? card.querySelector(COMPOSER_INPUT_SELECTOR) : null
        return { editor: editor ?? null, card: card ?? null }
      } catch (error) {
        console.error('[prompt-polish] composer measure targets unavailable:', error)
        return { editor: null, card: null }
      }
    }

    /**
     * One `ResizeObserver` when the shell has it; `null` otherwise (window resize still applies).
     * @param {() => void} onResize re-measure callback.
     * @returns {object | null} the observer, or null.
     */
    function createResizeObserver(onResize) {
      try {
        const Observer = globalThis.ResizeObserver
        if (typeof Observer !== 'function') return null
        return new Observer(() => onResize())
      } catch (error) {
        console.error('[prompt-polish] ResizeObserver unavailable:', error)
        return null
      }
    }

    /**
     * Estimated veil height from the draft when the editor cannot be measured: one line
     * per visual line (54 characters wide), on the same 24px pitch, clamped.
     * @param {string} draft the composer draft.
     * @returns {number} height in pixels.
     */
    function estimateSkeletonHeight(draft) {
      let visual = 1
      if (draft !== '') {
        visual = 0
        for (const line of draft.split('\n')) visual += Math.max(1, Math.ceil(line.length / 54))
      }
      const lines = Math.min(SKELETON_MAX_BARS, Math.max(2, visual))
      return lines * SKELETON_BAR_PITCH
    }

    /**
     * Bar count for one veil: one bar per editor line on the 24px pitch.
     *
     * Rows occupy `n*10 + (n-1)*14 = 24n - 14` pixels, so the count floors rather than
     * rounds: rounding up would make the last bar stick out of the measured box (and get
     * clipped by the veil's `overflow:hidden`, which looks like a half-drawn line).
     *
     * @param {number} height measured or estimated veil height.
     * @returns {number} bar count in `[1, SKELETON_MAX_BARS]`.
     */
    function skeletonBarCount(height) {
      const fits = (height + (SKELETON_BAR_PITCH - 10)) / SKELETON_BAR_PITCH
      const raw = Math.floor(fits)
      return Math.min(SKELETON_MAX_BARS, Math.max(1, Number.isFinite(raw) ? raw : 1))
    }

    /**
     * Bar widths for one veil: a repeating pattern so a tall block stays readable, with
     * the final bar always shorter than the one above it.
     * @param {number} count bar count.
     * @returns {string[]} CSS widths in percent.
     */
    function skeletonBarWidths(count) {
      const widths = []
      for (let index = 0; index < count; index += 1) {
        widths.push(SKELETON_BAR_PATTERN[index % SKELETON_BAR_PATTERN.length])
      }
      if (count === 1) {
        widths[0] = Math.min(widths[0], 64)
      } else {
        const previous = widths[count - 2]
        const candidate = SKELETON_LAST_WIDTHS[(count - 1) % SKELETON_LAST_WIDTHS.length]
        widths[count - 1] = Math.max(24, Math.min(candidate, previous - 10))
      }
      return widths.map((width) => `${width}%`)
    }

    /**
     * `conversation.input.overlay` — plays inside the composer card while the
     * rewrite runs, then unmounts.
     *
     * The veil covers the composer's whole text area at whatever height it currently
     * has: it measures the Lexical root on every paint of interest (mount, editor
     * resize, card resize, window resize) and sizes itself to that rect, so a tall
     * multi-line draft is fully covered instead of only its first lines. When the
     * measurement is unavailable it falls back to the draft-based estimate.
     *
     * Decorative: pointer-events none, aria-hidden, and a static (un-animated)
     * presentation under prefers-reduced-motion.
     */
    function PolishSkeleton(props) {
      const sessionId = props.sessionId
      const draftValue = props.useInput((state) => state.draft)
      const draft = typeof draftValue === 'string' ? draftValue : ''
      const state = usePolishState(sessionId)
      const pending = state.phase === 'pending'
      const veilRef = React.useRef(null)
      const [geometry, setGeometry] = React.useState(null)

      useLayoutEffectSafe(() => {
        if (!pending) {
          setGeometry(null)
          return undefined
        }
        const node = veilRef.current
        if (node === null || node === undefined) return undefined

        let live = true
        const measure = () => {
          if (!live) return
          const next = measureComposerEditor(veilRef.current)
          setGeometry((previous) => (
            previous !== null && next !== null
              && previous.top === next.top && previous.height === next.height
              ? previous
              : next
          ))
        }

        measure()

        const disposers = []
        const observer = createResizeObserver(measure)
        if (observer !== null) {
          const { editor, card } = composerMeasureTargets(veilRef.current)
          try {
            if (editor !== null) observer.observe(editor)
            if (card !== null) observer.observe(card)
          } catch (error) {
            console.error('[prompt-polish] could not observe the composer for resizes:', error)
          }
          disposers.push(() => observer.disconnect())
        }
        const host = globalThis.window
        if (host !== null && host !== undefined && typeof host.addEventListener === 'function') {
          host.addEventListener('resize', measure)
          disposers.push(() => host.removeEventListener('resize', measure))
        }

        return () => {
          live = false
          for (const dispose of disposers) {
            try {
              dispose()
            } catch (error) {
              console.error('[prompt-polish] composer measure cleanup failed:', error)
            }
          }
        }
      }, [pending, sessionId])

      if (!pending) return null

      const height = geometry !== null ? geometry.height : estimateSkeletonHeight(draft)
      const top = geometry !== null ? geometry.top : SKELETON_FALLBACK_TOP
      const widths = skeletonBarWidths(skeletonBarCount(height))

      return h(
        React.Fragment,
        null,
        h('style', null, SKELETON_CSS),
        h(
          'div',
          {
            className: 'pp-skeleton',
            ref: veilRef,
            'aria-hidden': 'true',
            'data-measured': geometry !== null ? 'true' : 'false',
            style: { top: `${top}px`, height: `${height}px` },
          },
          widths.map((width, index) => h('span', { key: index, className: 'pp-bar', style: { width } })),
        ),
      )
    }
    //#endregion

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          store = createPolishStore()
          // `ctx.get('conversation')` is resolved lazily on click: that service is owned by
          // another package and may activate after this plugin.
          pluginCtx = ctx
          return () => {
            pluginCtx = null
            store.dispose()
            store = null
          }
        }, 'prompt-polish: state store')

        // A reload (HMR) may re-apply before the previous layer was disposed; the
        // locale registry rejects a duplicate namespace+locale, which must not fail
        // activation of the whole plugin.
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, {
              zh: {
                'button.polish': '优化提示词',
                'button.pending': '正在优化提示词…',
                'button.undo': '撤回优化',
                'error.network': '网络请求失败，请重试',
                'error.timeout': '优化超时，请重试',
                'error.generic': '优化失败，请重试',
              },
              en: {
                'button.polish': 'Polish prompt',
                'button.pending': 'Polishing prompt…',
                'button.undo': 'Undo rewrite',
                'error.network': 'Network request failed, please retry',
                'error.timeout': 'Polishing timed out, please retry',
                'error.generic': 'Could not polish the prompt, please retry',
              },
            })
          } catch (error) {
            console.error('[prompt-polish] locale dictionaries already registered:', error)
            return () => {}
          }
        }, 'prompt-polish: dictionaries')

        boundT = ctx.locale.bind(NS)

        ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
          name: 'conversation.input.activity',
          locale: NS,
        }, PolishButton))

        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'prompt-polish-skeleton',
          order: 50,
          locale: NS,
        }, PolishSkeleton))
      },
    }
  },
})
