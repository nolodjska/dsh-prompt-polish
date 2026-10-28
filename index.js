import { optimizePrompt } from './optimize.js'

/**
 * Exact Fetch route served through the shared `/api` bridge (same origin as the Web GUI,
 * authenticated by the browser session cookie). The browser half posts one draft plus the
 * attachments docked on it; the reply is rendered in the composer. Nothing here enters the
 * session log or the model conversation.
 */
const ROUTE = '/api/prompt-polish/optimize'

export const inject = ['connection', 'llm', 'sessions', 'attachments', 'fileUploads', 'agents']

/** JSON reply helper; failures keep HTTP 200 so the page can read the reason from the body. */
function reply(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export function apply(ctx) {
  const optimizeRoute = {
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let payload
      try {
        payload = await request.json()
      } catch {
        return reply({ ok: false, message: 'prompt-polish: invalid JSON body' }, 400)
      }
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
      const text = typeof payload?.text === 'string' ? payload.text : ''
      if (sessionId === '') return reply({ ok: false, message: 'prompt-polish: missing sessionId' }, 400)
      // `attachments` is forwarded verbatim: `optimizePrompt` owns every shape check and
      // degrades an unreadable attachment to metadata instead of failing the request.
      try {
        return reply(await optimizePrompt(ctx, {
          sessionId,
          text,
          attachments: payload?.attachments,
          signal: request.signal,
        }))
      } catch (error) {
        return reply({ ok: false, message: `prompt-polish: ${error?.message ?? 'optimize failed'}` })
      }
    },
  }

  ctx.effect(() => ctx.connection.fetch.register(optimizeRoute), 'prompt-polish: optimize route')
}
