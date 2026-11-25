import type { VerifyWebhookOptions, WebhookHeaders, WebhookPayload } from './webhooks.js'
import type {
  Contact,
  Email,
  EmailBatchCreated,
  EmailCreated,
  SendEmailParams,
  UpdateContactParams,
  UpsertContactParams,
  WebhookEvent,
} from './types.js'
import { LystokError } from './errors.js'
import { VERSION } from './version.js'
import { verifyWebhook } from './webhooks.js'

export interface LystokOptions {
  /** Default `https://api.lystok.com`. */
  baseUrl?: string
  /** How long one attempt may take, in milliseconds. Default 30 000. */
  timeout?: number
  /**
   * How many times to try again after a network error, a timeout, 429 or 5xx. Default 2.
   * Safe for emails too: every send carries an `Idempotency-Key`, so a retry never sends twice.
   */
  maxRetries?: number
  /** Your own `fetch`, e.g. for a proxy or tests. */
  fetch?: typeof fetch
}

export interface RequestOptions {
  /**
   * The same key sent again within 24 hours gets the first answer back instead of a second
   * email: use your order id, for example. Made up for you when not given, which protects
   * this call's own retries.
   */
  idempotencyKey?: string
  signal?: AbortSignal
  /** Overrides the client's timeout for this call, in milliseconds. */
  timeout?: number
}

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  options?: RequestOptions
  idempotencyKey?: string
}

const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504])

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function envApiKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.LYSTOK_API_KEY
}

/**
 * The Lystok API client.
 *
 * ```ts
 * const lystok = new Lystok(process.env.LYSTOK_API_KEY)
 * const { id } = await lystok.emails.send({ from: 'Shop <orders@shop.example>', to: 'olena@example.com', subject: 'Hi', html: '<p>Hi!</p>' })
 * ```
 */
export class Lystok {
  readonly emails: Emails
  readonly contacts: Contacts
  readonly webhooks: Webhooks

  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #timeout: number
  readonly #maxRetries: number
  readonly #fetch: typeof fetch

  /** @param apiKey An API key from Settings → For developers; `LYSTOK_API_KEY` when not given. */
  constructor(apiKey?: string, options: LystokOptions = {}) {
    const key = apiKey ?? envApiKey()
    if (!key)
      throw new Error('Missing API key: pass it to new Lystok(\'lk_live_…\') or set LYSTOK_API_KEY')
    this.#apiKey = key
    this.#baseUrl = (options.baseUrl ?? 'https://api.lystok.com').replace(/\/+$/, '')
    this.#timeout = options.timeout ?? 30_000
    this.#maxRetries = Math.max(0, options.maxRetries ?? 2)
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.emails = new Emails(this)
    this.contacts = new Contacts(this)
    this.webhooks = new Webhooks()
  }

  /** @internal */
  async request<T>(call: Call): Promise<T> {
    const url = `${this.#baseUrl}/v1${call.path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.#apiKey}`,
      'Accept': 'application/json',
      'User-Agent': `lystok-js/${VERSION}`,
    }
    if (call.body !== undefined)
      headers['Content-Type'] = 'application/json'
    if (call.idempotencyKey)
      headers['Idempotency-Key'] = call.idempotencyKey
    const body = call.body === undefined ? undefined : JSON.stringify(call.body)
    const timeout = call.options?.timeout ?? this.#timeout

    for (let attempt = 0; ; attempt++) {
      let error: LystokError
      const signals = [AbortSignal.timeout(timeout)]
      if (call.options?.signal)
        signals.push(call.options.signal)
      try {
        const res = await this.#fetch(url, { method: call.method, headers, body, signal: AbortSignal.any(signals) })
        if (res.ok)
          return (res.status === 204 ? undefined : await res.json()) as T
        // A DELETE whose first try went through before the network failed finds nothing.
        if (res.status === 404 && call.method === 'DELETE' && attempt > 0)
          return undefined as T
        error = await errorFrom(res)
        const retry = RETRY_STATUSES.has(res.status) || error.code === 'idempotency_in_progress'
        if (!retry || attempt >= this.#maxRetries)
          throw error
      }
      catch (err) {
        if (err instanceof LystokError)
          throw err
        if (call.options?.signal?.aborted)
          throw err
        const timedOut = err instanceof Error && err.name === 'TimeoutError'
        error = new LystokError({
          status: 0,
          code: timedOut ? 'timeout' : 'connection_error',
          message: timedOut ? `No answer from the Lystok API within ${timeout} ms` : 'Could not reach the Lystok API',
          cause: err,
        })
        if (attempt >= this.#maxRetries)
          throw error
      }
      const backoff = Math.min(500 * 2 ** attempt, 8_000) * (0.75 + Math.random() / 2)
      await sleep(error.retryAfter === null ? backoff : Math.min(error.retryAfter, 60) * 1000)
    }
  }
}

async function errorFrom(res: Response): Promise<LystokError> {
  const retryAfter = Number(res.headers.get('retry-after'))
  let parsed: { error?: { code?: string, message?: string, params?: Record<string, string | number>, issues?: { path: string, message: string }[], requestId?: string } } = {}
  try {
    parsed = await res.json()
  }
  catch {}
  const e = parsed.error ?? {}
  return new LystokError({
    status: res.status,
    code: e.code ?? (res.status >= 500 ? 'server_error' : 'http_error'),
    message: e.message ?? `The Lystok API answered ${res.status}`,
    params: e.params,
    issues: e.issues,
    requestId: e.requestId ?? res.headers.get('x-request-id'),
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  })
}

const segment = (value: string) => encodeURIComponent(value)
const newKey = () => crypto.randomUUID()

export class Emails {
  readonly #client: Lystok
  constructor(client: Lystok) {
    this.#client = client
  }

  /** Sends one email. It is queued and usually sent within a second. */
  send(email: SendEmailParams, options?: RequestOptions): Promise<EmailCreated> {
    return this.#client.request({ method: 'POST', path: '/emails', body: email, options, idempotencyKey: options?.idempotencyKey ?? newKey() })
  }

  /** Sends up to 100 emails in one request; all are accepted or none. Ids come in the same order. */
  sendBatch(emails: SendEmailParams[], options?: RequestOptions): Promise<EmailBatchCreated> {
    return this.#client.request({ method: 'POST', path: '/emails/batch', body: emails, options, idempotencyKey: options?.idempotencyKey ?? newKey() })
  }

  /** What happened to an email. */
  get(id: string, options?: RequestOptions): Promise<Email> {
    return this.#client.request({ method: 'GET', path: `/emails/${segment(id)}`, options })
  }
}

export class Contacts {
  readonly #client: Lystok
  constructor(client: Lystok) {
    this.#client = client
  }

  /** Adds a person, or updates them when the address is already there. Safe to repeat. */
  upsert(contact: UpsertContactParams, options?: RequestOptions): Promise<Contact> {
    return this.#client.request({ method: 'POST', path: '/contacts', body: contact, options })
  }

  /** By id or by email address. */
  get(idOrEmail: string, options?: RequestOptions): Promise<Contact> {
    return this.#client.request({ method: 'GET', path: `/contacts/${segment(idOrEmail)}`, options })
  }

  /** Changes a person, found by id or by email address. */
  update(idOrEmail: string, changes: UpdateContactParams, options?: RequestOptions): Promise<Contact> {
    return this.#client.request({ method: 'PATCH', path: `/contacts/${segment(idOrEmail)}`, body: changes, options })
  }

  /** Deletes a person, found by id or by email address. */
  async delete(idOrEmail: string, options?: RequestOptions): Promise<void> {
    await this.#client.request({ method: 'DELETE', path: `/contacts/${segment(idOrEmail)}`, options })
  }
}

export class Webhooks {
  /** See `verifyWebhook`. */
  verify(payload: WebhookPayload, headers: WebhookHeaders, secret: string, options?: VerifyWebhookOptions): Promise<WebhookEvent> {
    return verifyWebhook(payload, headers, secret, options)
  }
}
