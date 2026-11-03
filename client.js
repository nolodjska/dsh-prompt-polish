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
 *   - conversation.input.dock      (list,   session) -> PolishPlanDock (id prompt-polish-plan, order 6)
 *
 * The dock is a full-width entry above the composer card: it carries the v2 diagnostic
 * panel (what was filled in, what still needs a decision) and sends the clarification answers
 * the user CHOSE, in one round, by replaying the ORIGINAL draft. Clicking an option only marks
 * it; nothing leaves the page until 确认 — a click must never double as the confirmation.
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
    /**
     * Stable identity for "this host exposes no composer hooks". The reveal gate compares by
     * identity, so a re-measure that keeps failing must not mint a new object and re-render.
     */
    const FALLBACK_LAYOUT = Object.freeze({ fallback: true })
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

    /** Confirmed clarification answers per request (design v2 §2: at most 6). */
    const MAX_ANSWERS = 6
    /**
     * Client-side plan ceilings. The Host trims every plan field first (design v2 §4.2);
     * these repeat the same limits so an untrimmed plan still cannot break the layout.
     * Rendering is the second line of defence, not the first.
     */
    const PLAN_MAX_NOTES = 120
    const PLAN_MAX_ASSUMPTIONS = 6
    const PLAN_MAX_SLOT = 16
    const PLAN_MAX_VALUE = 60
    const PLAN_MAX_QUESTIONS = 3
    const PLAN_MAX_QUESTION = 40
    const PLAN_MAX_OPTIONS = 4
    const PLAN_MAX_OPTION = 20
    /** Task types the model may report; any other value omits the type label entirely. */
    const PLAN_TYPES = new Set(['coding', 'writing', 'analysis', 'image', 'other'])
    /** Single-character ellipsis appended to a clipped plan field. */
    const ELLIPSIS = '…'
    /**
     * Shortest draft worth polishing: below this the model has nothing to work with, so the
     * control stays disabled instead of spending a call on a fragment of a word.
     */
    const MIN_DRAFT_CHARS = 4

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
    /** Frozen empty answer list: most states carry no confirmed answers. */
    const NO_ANSWERS = Object.freeze([])

    /** Frozen empty selection: question → chosen option, before the user confirms. */
    const EMPTY_SELECTION = Object.freeze({})

    /**
     * Keep only well-formed `{ q, a }` answers, in order.
     *
     * At most MAX_ANSWERS are retained — the protocol ceiling (design v2 §2) — and when
     * more arrive the NEWEST win, because the user's latest decisions are the ones the
     * next round must honour. A repeated question keeps its latest answer.
     * @param {unknown} value candidate answer list.
     * @returns {readonly {q: string, a: string}[]} the usable answers (frozen empty when none).
     */
    function normalizeAnswers(value) {
      if (!Array.isArray(value) || value.length === 0) return NO_ANSWERS
      const out = []
      const indexOf = new Map()
      for (const item of value) {
        if (item === null || typeof item !== 'object') continue
        if (typeof item.q !== 'string' || item.q === '') continue
        if (typeof item.a !== 'string' || item.a === '') continue
        if (indexOf.has(item.q)) {
          out[indexOf.get(item.q)] = { q: item.q, a: item.a }
          continue
        }
        indexOf.set(item.q, out.length)
        out.push({ q: item.q, a: item.a })
      }
      if (out.length === 0) return NO_ANSWERS
      return out.length > MAX_ANSWERS ? out.slice(out.length - MAX_ANSWERS) : out
    }

    /**
     * One immutable state per session id, shared by the toolbar button, the composer
     * overlay and the clarification dock (three separate slot entries). Owned by `apply`
     * via ctx.effect, which aborts every in-flight request on unload.
     *
     * state = { phase: 'idle', error: string | null, original: null, written: null,
     *           plan: null, answers: NO_ANSWERS, planHidden: false }
     *       | { phase: 'pending', mode: 'polish' | 'refine', token, controller,
     *           original, requestText, written, plan, answers, previousAnswers?,
     *           planHidden, applied?, error: null }
     *       | { phase: 'done', token, controller: null, original, written,
     *           plan, answers, planHidden, applied, error: string | null }
     *
     * `original` is always the draft captured by the FIRST rewrite, so undo keeps
     * returning to what the user typed even after a clarification round. `requestText`
     * is what the wire replays: the draft for polish, the original draft for refine.
     */
    function createPolishStore() {
      const IDLE = Object.freeze({
        phase: 'idle',
        error: null,
        original: null,
        written: null,
        plan: null,
        answers: NO_ANSWERS,
        planHidden: false,
      })
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
        /** Start a first rewrite; returns the pending entry (null when one is already live). */
        begin(sessionId, draft) {
          if (disposed || sessionId === undefined) return null
          const live = read(sessionId)
          if (live.phase !== 'idle') return null
          seq += 1
          const entry = {
            phase: 'pending',
            mode: 'polish',
            error: null,
            original: draft,
            requestText: draft,
            written: null,
            plan: null,
            answers: NO_ANSWERS,
            planHidden: false,
            token: seq,
            controller: new AbortController(),
          }
          entries.set(sessionId, entry)
          notify()
          return entry
        },
        /**
         * Start a clarification round from a finished rewrite.
         *
         * `begin` only starts from IDLE, because a first rewrite replaces a draft the user
         * has not seen replaced yet; a refine starts from DONE by design — it replays the
         * ORIGINAL draft with the answers the user just confirmed. Single-flight still
         * holds: a click while any request is live (polish or refine) is a no-op, so two
         * clarification rounds can never run concurrently in one Session.
         */
        beginRefine(sessionId, answers) {
          if (disposed || sessionId === undefined) return null
          const live = read(sessionId)
          if (live.phase !== 'done') return null
          const confirmed = normalizeAnswers(answers)
          if (confirmed.length === 0) return null
          seq += 1
          const entry = {
            phase: 'pending',
            mode: 'refine',
            error: null,
            original: live.original,
            requestText: live.original,
            // Kept so a failed refine can restore the previous finished state verbatim.
            written: live.written,
            plan: live.plan,
            answers: confirmed,
            // The failed round's own answer must NOT stick: restoring the previous list
            // keeps the question the user just clicked askable, so they can retry.
            previousAnswers: live.answers,
            planHidden: live.planHidden === true,
            applied: live.applied === true,
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
        /**
         * Rewrite landed: remember what we replaced and what we wrote.
         * @param {object | null} plan normalized diagnostic (null when the Host sent none).
         */
        succeed(sessionId, token, written, plan = null) {
          const live = current(sessionId, token)
          if (live === null) return false
          const refining = live.mode === 'refine'
          entries.set(sessionId, {
            phase: 'done',
            error: null,
            original: live.original,
            written,
            // The fresh diagnostic describes the text just written. A reply without PLAN
            // (degradation, not failure) means "nothing to show": keeping the previous
            // plan would describe a rewrite that is no longer in the draft.
            plan,
            answers: refining ? live.answers : NO_ANSWERS,
            planHidden: refining ? live.planHidden : false,
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
        /**
         * Put the diagnostic panel away without touching the undo affordance: the draft
         * stays rewritten and ↺ still restores the user's original text.
         */
        hidePlan(sessionId) {
          const live = read(sessionId)
          if (live.phase !== 'done' || live.planHidden === true) return false
          entries.set(sessionId, { ...live, planHidden: true })
          notify()
          return true
        },
        /** Rewrite failed: keep the draft untouched, surface one short message. */
        fail(sessionId, token, message) {
          const live = current(sessionId, token)
          if (live === null) return false
          if (live.mode === 'refine') {
            // A failed clarification must not throw away the diagnostic or the undo
            // affordance the user already had, and it must not touch the draft: restore
            // the previous finished state and surface the message on the same channel.
            entries.set(sessionId, {
              phase: 'done',
              error: message,
              original: live.original,
              written: live.written,
              plan: live.plan,
              answers: live.previousAnswers ?? NO_ANSWERS,
              planHidden: live.planHidden,
              token: live.token,
              controller: null,
              applied: live.applied === true,
            })
          } else {
            entries.set(sessionId, {
              phase: 'idle',
              error: message,
              original: null,
              written: null,
              plan: null,
              answers: NO_ANSWERS,
              planHidden: false,
            })
          }
          notify()
          return true
        },
        clearError(sessionId) {
          const live = read(sessionId)
          if (live.error === null) return
          // A refine failure restores DONE (panel + undo stay); only the message expires.
          if (live.phase === 'done') {
            entries.set(sessionId, { ...live, error: null })
            notify()
            return
          }
          if (live.phase === 'idle') drop(sessionId)
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
    const IDLE_STATE = Object.freeze({
      phase: 'idle',
      error: null,
      original: null,
      written: null,
      plan: null,
      answers: NO_ANSWERS,
      planHidden: false,
    })

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

    //#region plan
    /**
     * Clip one plan field to its display ceiling, appending an ellipsis when it was longer.
     * Counts Unicode code points so a clipped surrogate pair is never cut in half.
     * @param {unknown} value candidate field.
     * @param {number} max maximum number of characters.
     * @returns {string} trimmed, clipped text (empty when the field is absent).
     */
    function clipPlanText(value, max) {
      if (typeof value !== 'string') return ''
      const text = value.trim()
      if (text === '') return ''
      const chars = Array.from(text)
      if (chars.length <= max) return text
      return chars.slice(0, Math.max(1, max - 1)).join('') + ELLIPSIS
    }

    /**
     * Normalize the Host's optional `plan` block into the shape the dock renders.
     *
     * The Host already parses, sanitizes and trims it (design v2 §4); this pass exists so
     * an older or looser Host build cannot paint garbage or an unbounded layout. A plan
     * with nothing to show becomes null, which is exactly the v1 presentation (no panel).
     *
     * @param {unknown} value raw `plan` field from the wire.
     * @returns {{ type: string, notes: string,
     *   assumptions: { slot: string, value: string }[],
     *   questions: { q: string, options: string[] }[] } | null} the normalized plan, or null.
     */
    function readPlan(value) {
      if (value === null || typeof value !== 'object') return null
      const rawType = typeof value.type === 'string' ? value.type.trim().toLowerCase() : ''
      const type = PLAN_TYPES.has(rawType) ? rawType : ''
      const notes = clipPlanText(value.notes, PLAN_MAX_NOTES)

      const assumptions = []
      if (Array.isArray(value.assumptions)) {
        for (const item of value.assumptions) {
          if (assumptions.length >= PLAN_MAX_ASSUMPTIONS) break
          if (item === null || typeof item !== 'object') continue
          const slot = clipPlanText(item.slot, PLAN_MAX_SLOT)
          const text = clipPlanText(item.value, PLAN_MAX_VALUE)
          if (slot === '' || text === '') continue
          assumptions.push({ slot, value: text })
        }
      }

      const questions = []
      if (Array.isArray(value.questions)) {
        for (const item of value.questions) {
          if (questions.length >= PLAN_MAX_QUESTIONS) break
          if (item === null || typeof item !== 'object') continue
          const q = clipPlanText(item.q, PLAN_MAX_QUESTION)
          if (q === '') continue
          const options = []
          if (Array.isArray(item.options)) {
            for (const option of item.options) {
              if (options.length >= PLAN_MAX_OPTIONS) break
              const text = clipPlanText(option, PLAN_MAX_OPTION)
              if (text !== '') options.push(text)
            }
          }
          // A question without an option has nothing to click, so it cannot be answered.
          if (options.length === 0) continue
          questions.push({ q, options })
        }
      }

      if (type === '' && notes === '' && assumptions.length === 0 && questions.length === 0) return null
      return { type, notes, assumptions, questions }
    }
    //#endregion

    //#region request
    /**
     * One optimize round trip, shared by the v1 control (polish) and the v2 dock (refine):
     * same route, same timeout budget (images get more), same abort rules, same
     * cross-Session write-back and the same Session-liveness check.
     *
     * Everything below belongs to the Session that STARTED the request, whichever Session
     * is open when it settles. The store entry is settled here; the caller only resolves
     * the attachment payload and hands over the body.
     *
     * @param {string} origin Session id that owns this request entry.
     * @param {number} token store token of that pending entry.
     * @param {AbortController} controller abort handle owned by the entry.
     * @param {object} body JSON body (`sessionId`, `text`, optional `attachments`/`answers`).
     * @param {(key: string, params?: object) => string} t translator bound to this locale.
     * @param {{ current: unknown }} sessionsRef live Session catalog snapshot.
     * @returns {Promise<void>} resolves once the store is settled; never rejects.
     */
    async function sendOptimizeRequest(origin, token, controller, body, t, sessionsRef) {
      let timedOut = false
      let timer
      const settle = () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      }
      const hasImages = Array.isArray(body.attachments) && body.attachments.some((item) => item.type === 'image')
      timer = setTimeout(() => {
        timedOut = true
        try {
          controller.abort()
        } catch (_error) {
          /* already settled */
        }
      }, hasImages ? TIMEOUT_MS_WITH_IMAGES : TIMEOUT_MS)

      // Everything below belongs to the Session that STARTED this request, whichever
      // Session is open when it settles.
      const originAlive = () => isSessionAlive(sessionsRef?.current, origin)

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
      store.succeed(origin, token, text, readPlan(payload.plan))
    }

    /**
     * Resolve the draft's docked attachments (best effort) and dispatch one round — the
     * single entry point shared by the v1 control and the clarification dock, so both
     * obey the same synchronous-when-empty behaviour and the same post-await re-check.
     *
     * @param {string} sessionId Session that owns the pending entry.
     * @param {{ token: number, controller: AbortController }} started the pending entry.
     * @param {readonly string[]} ids draft-local attachment ids in rail order.
     * @param {object} body JSON body without attachments (filled in here).
     * @param {(key: string, params?: object) => string} t translator bound to this locale.
     * @param {{ current: unknown }} sessionsRef live Session catalog snapshot.
     * @returns {Promise<void>} resolves once the store is settled; never rejects.
     */
    async function dispatchOptimize(sessionId, started, ids, body, t, sessionsRef) {
      let attachments = NO_ATTACHMENTS
      if (ids.length > 0) {
        attachments = await resolvePolishAttachments(ids)
        // Full re-check after the await: the session may have changed, the request may
        // have been aborted, or the plugin may have been disposed meanwhile.
        if (store === null || !store.isCurrent(sessionId, started.token)) return
      }
      if (attachments.length > 0) body.attachments = attachments
      return sendOptimizeRequest(sessionId, started.token, started.controller, body, t, sessionsRef)
    }
    //#endregion

    //#region styles
    const BUTTON_CSS = `
.pp-root{display:inline-flex;align-items:center;gap:8px;min-width:0}
.pp-wrap{display:inline-flex;flex:none}
.pp-btn{box-sizing:border-box;width:28px;height:28px;flex:none;display:grid;place-items:center;padding:0;margin:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s ease,color .12s ease,opacity .12s ease}
.pp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary)}
.pp-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.pp-btn:focus{outline:none}
.pp-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#a8c7fa);outline-offset:1px}
.pp-btn:disabled{opacity:.45;cursor:default}
.pp-btn[data-phase="done"]{color:var(--dsw-alias-state-business-primary,#a8c7fa)}
.pp-btn[data-phase="done"]:hover:not(:disabled){color:var(--dsw-alias-state-business-primary,#a8c7fa)}
.pp-icon{display:block;pointer-events:none}
.pp-spin{animation:pp-spin 1s linear infinite;transform-origin:50% 50%}
@keyframes pp-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.pp-error{font:inherit;font-size:12px;line-height:18px;max-width:190px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-state-error-primary);opacity:.9}
@media (prefers-reduced-motion: reduce){.pp-spin{animation:none}}
`

    const SKELETON_CSS = `
.pp-skeleton{position:absolute;z-index:1;left:14px;right:10px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:flex-start;gap:14px;padding:4px 0;overflow:hidden;border-radius:var(--dsw-radius-sm,6px);pointer-events:none;cursor:default;user-select:none;
background:#1f1f22;
background:var(--dsw-specific-input-major,#1f1f22);
background:color-mix(in srgb,var(--dsw-specific-input-major,#1f1f22) 94%,var(--dsw-alias-bg-layer-1,#1f1f22))}
.pp-skeleton[data-armed="true"]{transition:top .18s ease,height .18s ease}
.pp-bar{flex:none;height:10px;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08)) 0%,var(--dsw-alias-interactive-bg-hover-solid) 50%,var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08)) 100%);background-size:220% 100%;animation:pp-shimmer 1.3s ease-in-out infinite}
.pp-bar:nth-child(3n+2){animation-delay:.12s}
.pp-bar:nth-child(3n+3){animation-delay:.24s}
@keyframes pp-shimmer{from{background-position:120% 0}to{background-position:-120% 0}}
@media (prefers-reduced-motion: reduce){.pp-skeleton{transition:none}.pp-skeleton[data-armed="true"]{transition:none}.pp-bar{animation:none;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}}
`

    /**
     * The diagnostic panel sits in `conversation.input.dock` and is sized like the shipped
     * panels above the composer card (TodoPanel/QueueDock): full width of the composer
     * column, the menu surface, one hairline border, rounded top corners.
     */
    const PLAN_CSS = `
.pp-plan{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,760px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));flex:none;display:flex;flex-direction:column;gap:6px;margin:0 auto;padding:8px 12px 10px;border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,#1f1f22);backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-panel,none);color:var(--dsw-alias-label-secondary,#a9a9b0);font-size:12px;line-height:20px;overflow:hidden}
.pp-plan-head{display:flex;align-items:center;gap:8px;min-width:0}
.pp-plan-type{box-sizing:border-box;flex:none;padding:0 5px;border:.5px solid var(--dsw-alias-state-business-primary,#a8c7fa);border-radius:5px;color:var(--dsw-alias-state-business-primary,#a8c7fa);font-size:11px;line-height:16px;white-space:nowrap}
.pp-plan-summary{flex:auto;min-width:0;color:var(--dsw-alias-label-secondary,#a9a9b0);font-size:12px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-plan-close{box-sizing:border-box;flex:none;width:20px;height:20px;display:grid;place-items:center;padding:0;margin:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a91);font:inherit;font-size:14px;line-height:1;cursor:pointer}
.pp-plan-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f2f5)}
.pp-plan-close:focus{outline:none}
.pp-plan-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#a8c7fa);outline-offset:1px}
.pp-plan-row{display:flex;align-items:flex-start;gap:8px;min-width:0}
.pp-plan-tag{flex:none;min-width:36px;color:var(--dsw-alias-label-tertiary,#8a8a91);font-size:11px;line-height:20px;white-space:nowrap}
.pp-plan-chips{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.pp-plan-chip{box-sizing:border-box;display:inline-flex;align-items:baseline;gap:5px;max-width:100%;padding:0 6px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));font-size:12px;line-height:18px}
.pp-plan-chip-k{flex:none;color:var(--dsw-alias-label-tertiary,#8a8a91)}
.pp-plan-chip-v{color:var(--dsw-alias-label-primary,#f2f2f5);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-plan-chip[data-disabled="true"]{opacity:.55}
.pp-plan-asks{display:flex;flex-direction:column;gap:7px;min-width:0}
.pp-plan-ask{display:flex;flex-direction:column;gap:5px;min-width:0}
.pp-plan-q{color:var(--dsw-alias-label-primary,#f2f2f5);font-size:12px;line-height:18px}
.pp-plan-seg{display:flex;flex-wrap:wrap;align-self:flex-start;max-width:100%}
.pp-plan-opt{box-sizing:border-box;max-width:100%;padding:1px 10px;margin:0 0 0 -.5px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-radius:0;background:transparent;color:var(--dsw-alias-label-secondary,#a9a9b0);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.pp-plan-opt:first-child{margin-left:0;border-radius:7px 0 0 7px}
.pp-plan-opt:last-child{border-radius:0 7px 7px 0}
.pp-plan-opt:only-child{border-radius:7px}
.pp-plan-opt:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#f2f2f5)}
.pp-plan-opt[data-rec="true"]{position:relative;padding-left:19px;color:var(--dsw-alias-label-primary,#f2f2f5)}
.pp-plan-opt[data-rec="true"]::before{content:"★";position:absolute;left:7px;top:1px;font-size:9px;line-height:18px;color:var(--dsw-alias-state-business-primary,#a8c7fa)}
.pp-plan-opt[data-selected="true"],.pp-plan-opt[data-selected="true"]:hover{background:var(--dsw-alias-state-business-primary,#a8c7fa);border-color:var(--dsw-alias-state-business-primary,#a8c7fa);color:var(--dsw-alias-label-primary-inverted,#0b0b0d);font-weight:500}
.pp-plan-opt[data-selected="true"]::after{content:"✓";margin-left:5px;font-size:10px}
.pp-plan-opt[data-selected="true"][data-rec="true"]::before{color:var(--dsw-alias-label-primary-inverted,#0b0b0d)}
.pp-plan-opt:focus{outline:none}
.pp-plan-opt:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#a8c7fa);outline-offset:-1px}
.pp-plan-foot{display:flex;align-items:center;gap:10px;min-width:0;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14))}
.pp-plan-notes{min-width:0;color:var(--dsw-alias-label-tertiary,#8a8a91);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-plan-progress{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary,#8a8a91);white-space:nowrap}
.pp-plan-confirm{box-sizing:border-box;flex:none;padding:1px 12px;border:.5px solid var(--dsw-alias-state-business-primary,#a8c7fa);border-radius:7px;background:var(--dsw-alias-state-business-primary,#a8c7fa);color:var(--dsw-alias-label-primary-inverted,#0b0b0d);font:inherit;font-size:12px;font-weight:500;line-height:18px;cursor:pointer}
.pp-plan-confirm:hover:not(:disabled){filter:brightness(1.08)}
.pp-plan-confirm:disabled{background:transparent;border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.14));color:var(--dsw-alias-label-tertiary,#8a8a91);cursor:default}
.pp-plan-confirm:focus{outline:none}
.pp-plan-confirm:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#a8c7fa);outline-offset:1px}
.pp-plan-busy{flex-direction:column;align-items:stretch;gap:6px}
.pp-plan-busy-line{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary,#a9a9b0)}
.pp-plan-spinner{box-sizing:border-box;flex:none;width:10px;height:10px;border:1.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));border-top-color:var(--dsw-alias-state-business-primary,#a8c7fa);border-radius:50%;animation:pp-plan-spin .8s linear infinite}
@keyframes pp-plan-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.pp-plan-spinner{animation:none}}
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
      // One gate for "too little to rewrite": a blank draft and a fragment of a word are
      // the same problem, so the control stays disabled in both cases.
      const tooShort = draft.trim().length < MIN_DRAFT_CHARS
      const disabled = polishing || props.locked === true || (!undoable && (tooShort || sessionId === undefined))

      const runPolish = () => {
        if (disabled || polishing || undoable || store === null) return
        const started = store.begin(sessionId, draft)
        if (started === null) return
        const body = { sessionId, text: draft }
        dispatchOptimize(sessionId, started, readAttachmentIds(attachmentIdsValue), body, t, sessionsRef).catch((failure) => {
          // Defensive: every inner path handles its own failure, so reaching this means a
          // bug. Settle the state instead of leaving a spinner running forever.
          console.error('[prompt-polish] rewrite dispatch failed:', failure)
          if (store !== null) store.fail(sessionId, started.token, t('error.generic'))
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
     * Run `fn` once the browser has had a chance to paint the current frame, and return its
     * canceller. `requestAnimationFrame` is the exact primitive (it fires before the NEXT
     * paint, i.e. after the current one); a 0ms timer is the fallback for shells without it.
     * @param {() => void} fn callback.
     * @returns {() => void} canceller.
     */
    function scheduleAfterPaint(fn) {
      const raf = globalThis.requestAnimationFrame
      if (typeof raf === 'function') {
        const id = raf(fn)
        return () => {
          try {
            if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id)
          } catch (_error) {
            /* already fired */
          }
        }
      }
      const id = setTimeout(fn, 0)
      return () => clearTimeout(id)
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
     * multi-line draft is fully covered instead of only its first lines.
     *
     * NEVER PAINT AN UNMEASURED BOX. A guessed top/height is wrong by construction (the
     * estimate counts draft lines, the real box is clipped by the composer's scrollport,
     * and the top depends on the attachment rail above the editor). Painting the guess and
     * then correcting it is exactly what made the veil appear somewhere else and slide into
     * the composer, because the top/height transition — which exists to smooth genuine
     * resizes while the user keeps typing — animated the correction too. So:
     *
     *   - until the first measurement attempt has completed, the veil is `visibility:hidden`
     *     (mounted, so the ref and the rect are real, but never seen at a guessed position);
     *   - the transition is armed only for the frame AFTER the first measured paint, so the
     *     initial placement is instantaneous and later resizes still animate;
     *   - the estimate is used only when the host exposes no composer hooks at all, where it
     *     is the only thing available and it is stable (no correction will ever follow).
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
      /**
       * `null` — not measured yet: stay hidden, never paint a guess.
       * `{ top, height }` — the measured box.
       * `{ fallback: true }` — this host exposes no composer hooks: show the estimate.
       */
      const [layout, setLayout] = React.useState(null)
      /** Transitions stay off until the measured frame has been painted. */
      const [armed, setArmed] = React.useState(false)

      useLayoutEffectSafe(() => {
        if (!pending) {
          setLayout(null)
          setArmed(false)
          return undefined
        }
        const node = veilRef.current
        if (node === null || node === undefined) {
          // Nothing to measure against: show the estimate rather than an invisible veil.
          setLayout(FALLBACK_LAYOUT)
          return undefined
        }

        let live = true
        const measure = () => {
          if (!live) return
          const next = measureComposerEditor(veilRef.current)
          setLayout((previous) => {
            if (next === null) return previous === FALLBACK_LAYOUT ? previous : FALLBACK_LAYOUT
            if (previous !== null && previous.fallback !== true
              && previous.top === next.top && previous.height === next.height) return previous
            return next
          })
        }

        measure()
        // Arm the transition one frame later: the first placement must not tween.
        const cancelArm = scheduleAfterPaint(() => {
          if (live) setArmed(true)
        })

        const disposers = [cancelArm]
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

      const measured = layout !== null && layout.fallback !== true
      const height = measured ? layout.height : estimateSkeletonHeight(draft)
      const top = measured ? layout.top : SKELETON_FALLBACK_TOP
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
            'data-measured': measured ? 'true' : 'false',
            'data-armed': armed ? 'true' : 'false',
            // Hidden until a measurement attempt has completed: the first painted frame is
            // the final box, never a guess that would then animate into place.
            style: {
              top: `${top}px`,
              height: `${height}px`,
              ...(layout === null ? { visibility: 'hidden' } : {}),
            },
          },
          widths.map((width, index) => h('span', { key: index, className: 'pp-bar', style: { width } })),
        ),
      )
    }

    /**
     * `conversation.input.dock` — the v2 diagnostic panel, full width above the composer
     * card (same seat as the queue/todo/goal docks).
     *
     * Renders NOTHING in the v1 flow (no plan, or the user closed it), so a Host without
     * PLAN support degrades to exactly the v1 UI. While a clarification round runs it
     * collapses to one line with the (disabled) assumptions: the draft area already owns
     * the busy presentation (the skeleton), and the option buttons must not be clickable
     * twice. Clicking an option replays the ORIGINAL draft plus every confirmed answer —
     * the rewritten text is never sent back as input (design v2 §2).
     */
    function PolishPlanDock(props) {
      const t = useTranslate(props)
      const sessionId = props.sessionId
      const state = usePolishState(sessionId)
      const attachmentIdsValue = typeof props.useInput === 'function'
        ? props.useInput((input) => input.attachmentIds)
        : undefined
      const sessionsSnapshot = typeof props.useSessions === 'function' ? props.useSessions((snapshot) => snapshot) : undefined
      const sessionsRef = React.useRef(sessionsSnapshot)
      sessionsRef.current = sessionsSnapshot
      // Which option the user has CHOSEN, question → option. Local on purpose: a click marks a
      // choice, it never sends anything. A click used to BE the confirmation, so the first stray
      // click dispatched a rewrite round before the remaining questions could be read.
      const [selection, setSelection] = React.useState(EMPTY_SELECTION)

      const phase = state.phase
      const plan = state.plan
      const answers = state.answers ?? NO_ANSWERS
      const refining = phase === 'pending' && state.mode === 'refine'

      /** Replay the ORIGINAL draft with the confirmed answers, through the shared dispatch. */
      const startRefine = (started) => dispatchOptimize(
        sessionId,
        started,
        readAttachmentIds(attachmentIdsValue),
        { sessionId, text: started.requestText, answers: started.answers },
        t,
        sessionsRef,
      )

      /** Mark an option (or unmark it, on a second click). Nothing is dispatched here. */
      const toggleOption = (question, option) => {
        setSelection((current) => {
          if (current[question] === option) {
            const next = { ...current }
            delete next[question]
            return next
          }
          return { ...current, [question]: option }
        })
      }

      if (refining) {
        const chips = plan === null ? [] : plan.assumptions
        return h(
          React.Fragment,
          null,
          h('style', null, PLAN_CSS),
          h(
            'div',
            { className: 'pp-plan pp-plan-busy', role: 'status', 'aria-busy': 'true', 'data-phase': 'refining' },
            h(
              'div',
              { className: 'pp-plan-busy-line' },
              h('span', { className: 'pp-plan-spinner', 'aria-hidden': 'true' }),
              h('span', { className: 'pp-plan-busy-text' }, t('dock.refining')),
            ),
            chips.length === 0 ? null : h(
              'div',
              { className: 'pp-plan-row' },
              h('span', { className: 'pp-plan-tag' }, t('dock.assumptions')),
              h('span', { className: 'pp-plan-chips' }, chips.map((item, index) => h(
                'span',
                {
                  key: index,
                  className: 'pp-plan-chip',
                  'data-disabled': 'true',
                  title: `${item.slot}：${item.value}`,
                },
                h('span', { className: 'pp-plan-chip-k' }, item.slot),
                h('span', { className: 'pp-plan-chip-v' }, item.value),
              ))),
            ),
          ),
        )
      }

      if (phase !== 'done' || plan === null || state.planHidden === true) return null

      const answered = new Set(answers.map((item) => item.q))
      // A question the user already answered is never asked twice, even when the second
      // round's plan block repeats it verbatim (the Host cannot know what we showed).
      const questions = plan.questions.filter((item) => !answered.has(item.q))
      const assumptions = plan.assumptions
      const typeLabel = plan.type !== '' && PLAN_TYPES.has(plan.type) ? t(`dock.type.${plan.type}`) : ''

      // One short line instead of a sentence: the type is a badge of its own, and the two
      // counts are what the user actually scans for.
      const summary = [
        assumptions.length > 0 ? t('dock.summary.filled', { count: assumptions.length }) : '',
        questions.length > 0 ? t('dock.summary.pending', { count: questions.length }) : '',
      ].filter((part) => part !== '').join(' · ')

      const close = () => {
        if (store !== null) store.hidePlan(sessionId)
        setSelection(EMPTY_SELECTION)
      }

      // Every chosen answer travels in ONE round, so answering three questions costs one call
      // instead of three — and none of them leaves before the user says so.
      const chosen = questions.filter((item) => typeof selection[item.q] === 'string')
      const confirm = () => {
        if (store === null || phase !== 'done' || refining || chosen.length === 0) return
        const next = [...answers, ...chosen.map((item) => ({ q: item.q, a: selection[item.q] }))]
        const started = store.beginRefine(sessionId, next)
        if (started === null) return
        setSelection(EMPTY_SELECTION)
        startRefine(started).catch((failure) => {
          // Defensive: every inner path settles itself, so reaching this means a bug.
          console.error('[prompt-polish] clarification dispatch failed:', failure)
          if (store !== null) store.fail(sessionId, started.token, t('error.generic'))
        })
      }

      const progress = t('dock.progress', { done: chosen.length, total: questions.length })
      const notesText = plan.notes === '' ? '' : t('dock.notes', { notes: plan.notes })

      return h(
        React.Fragment,
        null,
        h('style', null, PLAN_CSS),
        h(
          'div',
          { className: 'pp-plan', 'data-phase': 'done', role: 'group', 'aria-label': summary },
          h(
            'div',
            { className: 'pp-plan-head' },
            typeLabel === '' ? null : h('span', { className: 'pp-plan-type' }, typeLabel),
            h('span', { className: 'pp-plan-summary' }, summary),
            h(
              'button',
              {
                type: 'button',
                className: 'pp-plan-close',
                'aria-label': t('dock.close'),
                title: t('dock.close'),
                // Keep the composer's caret where the user left it.
                onMouseDown: (event) => {
                  event.preventDefault()
                },
                onClick: close,
              },
              '×',
            ),
          ),
          assumptions.length === 0 ? null : h(
            'div',
            { className: 'pp-plan-row' },
            h('span', { className: 'pp-plan-tag' }, t('dock.assumptions')),
            h('span', { className: 'pp-plan-chips' }, assumptions.map((item, index) => h(
              'span',
              {
                key: index,
                className: 'pp-plan-chip',
                title: `${item.slot}：${item.value}`,
              },
              h('span', { className: 'pp-plan-chip-k' }, item.slot),
              h('span', { className: 'pp-plan-chip-v' }, item.value),
            ))),
          ),
          questions.length === 0 ? null : h(
            'div',
            { className: 'pp-plan-row' },
            h('span', { className: 'pp-plan-tag' }, t('dock.questions')),
            h('div', { className: 'pp-plan-asks' }, questions.map((item, index) => h(
              'div',
              { className: 'pp-plan-ask', key: index },
              h('span', { className: 'pp-plan-q' }, item.q),
              // One bordered group per question: a row of answers, not a pile of buttons.
              // options[0] is the Host's recommendation, marked with a ★ INSIDE the option so
              // the badge never competes with the answers for reading order.
              h('div', { className: 'pp-plan-seg' }, item.options.map((option, optionIndex) => h(
                'button',
                {
                  key: optionIndex,
                  type: 'button',
                  className: 'pp-plan-opt',
                  'data-rec': optionIndex === 0 ? 'true' : 'false',
                  title: optionIndex === 0 ? `${option} · ${t('dock.recommended')}` : option,
                  // Selection, not submission: the answer only leaves on 确认.
                  'aria-pressed': selection[item.q] === option ? 'true' : 'false',
                  'data-selected': selection[item.q] === option ? 'true' : 'false',
                  onMouseDown: (event) => {
                    event.preventDefault()
                  },
                  onClick: () => toggleOption(item.q, option),
                },
                option,
              ))),
            ))),
          ),
          notesText === '' && questions.length === 0 ? null : h(
            'div',
            { className: 'pp-plan-foot' },
            notesText === '' ? null : h('span', { className: 'pp-plan-notes', title: notesText }, notesText),
            questions.length === 0 ? null : h('span', { className: 'pp-plan-progress' }, progress),
            // One primary action for the whole panel: it stays disabled until something is chosen.
            questions.length === 0 ? null : h(
              'button',
              {
                type: 'button',
                className: 'pp-plan-confirm',
                disabled: chosen.length === 0,
                title: chosen.length === 0 ? t('dock.confirm.empty') : t('dock.confirm'),
                onMouseDown: (event) => {
                  event.preventDefault()
                },
                onClick: confirm,
              },
              chosen.length === 0 ? t('dock.confirm') : t('dock.confirm.count', { count: chosen.length }),
            ),
          ),
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
                // v2 diagnostic panel (`conversation.input.dock`).
                'dock.summary.filled': '补全 {count} 处',
                'dock.summary.pending': '待确认 {count}',
                'dock.assumptions': '补全',
                'dock.questions': '待确认',
                'dock.notes': '改动：{notes}',
                'dock.close': '收起诊断',
                'dock.refining': '正在按你的选择重写…',
                'dock.recommended': '推荐',
                'dock.progress': '已选 {done}/{total}',
                'dock.confirm': '确认并重写',
                'dock.confirm.count': '确认并重写（{count}）',
                'dock.confirm.empty': '先选一个答案，再确认',
                'dock.type.coding': '编码任务',
                'dock.type.writing': '写作任务',
                'dock.type.analysis': '分析任务',
                'dock.type.image': '图像任务',
                'dock.type.other': '通用任务',
              },
              en: {
                'button.polish': 'Polish prompt',
                'button.pending': 'Polishing prompt…',
                'button.undo': 'Undo rewrite',
                'error.network': 'Network request failed, please retry',
                'error.timeout': 'Polishing timed out, please retry',
                'error.generic': 'Could not polish the prompt, please retry',
                // v2 diagnostic panel (`conversation.input.dock`).
                'dock.summary.filled': 'Filled {count}',
                'dock.summary.pending': '{count} to confirm',
                'dock.assumptions': 'Filled',
                'dock.questions': 'Confirm',
                'dock.notes': 'Changed: {notes}',
                'dock.close': 'Hide diagnostics',
                'dock.refining': 'Rewriting with your choices…',
                'dock.recommended': 'Suggested',
                'dock.progress': 'Picked {done}/{total}',
                'dock.confirm': 'Confirm and rewrite',
                'dock.confirm.count': 'Confirm and rewrite ({count})',
                'dock.confirm.empty': 'Pick an answer first, then confirm',
                'dock.type.coding': 'Coding',
                'dock.type.writing': 'Writing',
                'dock.type.analysis': 'Analysis',
                'dock.type.image': 'Image',
                'dock.type.other': 'General',
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

        // Full-width entry above the composer card, beside the shipped queue/todo/goal docks.
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'prompt-polish-plan',
          order: 6,
          locale: NS,
        }, PolishPlanDock))
      },
    }
  },
})
