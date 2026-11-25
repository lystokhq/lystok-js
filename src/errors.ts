/** One problem in the request body, e.g. `{ path: 'to', message: 'Invalid email' }`. */
export interface ErrorIssue {
  path: string
  message: string
}

/**
 * Anything the API refused, or a request that never got an answer.
 *
 * `code` is stable and meant for your code (`validation`, `not_found`, `rate_limited`,
 * `plan_limit`, …); `message` is for people. Without an answer from the API, `status` is 0
 * and `code` is `connection_error` or `timeout`.
 */
export class LystokError extends Error {
  /** HTTP status, or 0 when no answer came. */
  readonly status: number
  readonly code: string
  readonly params: Record<string, string | number>
  readonly issues: ErrorIssue[]
  /** Quote it when you write to support. */
  readonly requestId: string | null
  /** Seconds to wait before trying again (429). */
  readonly retryAfter: number | null

  constructor(init: {
    status: number
    code: string
    message: string
    params?: Record<string, string | number>
    issues?: ErrorIssue[]
    requestId?: string | null
    retryAfter?: number | null
    cause?: unknown
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'LystokError'
    this.status = init.status
    this.code = init.code
    this.params = init.params ?? {}
    this.issues = init.issues ?? []
    this.requestId = init.requestId ?? null
    this.retryAfter = init.retryAfter ?? null
  }
}

/** A webhook whose signature or timestamp does not check out: answer it with 400 or 401. */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WebhookVerificationError'
  }
}
