/**
 * Checking that a webhook came from Lystok (the Standard Webhooks scheme): the headers
 * `webhook-id`, `webhook-timestamp` and `webhook-signature` sign `id.timestamp.body` with
 * HMAC-SHA256. Uses Web Crypto, so it works in Node.js, Bun, Deno and edge runtimes.
 */
import type { WebhookEvent } from './types.js'
import { WebhookVerificationError } from './errors.js'

export type WebhookPayload = string | Uint8Array | ArrayBuffer
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>

export interface VerifyWebhookOptions {
  /** How far the timestamp may be from now, in seconds. Default 300 (5 minutes). */
  tolerance?: number
  /** The current time; for tests. */
  now?: Date
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function')
    return (headers as Headers).get(name) ?? undefined
  const record = headers as Record<string, string | string[] | undefined>
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) {
      const value = record[key]
      return Array.isArray(value) ? value.join(' ') : value
    }
  }
  return undefined
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++)
      bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  catch {
    return null
  }
}

function bytesOf(payload: WebhookPayload): Uint8Array {
  if (typeof payload === 'string')
    return encoder.encode(payload)
  return payload instanceof Uint8Array ? payload : new Uint8Array(payload)
}

/** Compares in constant time, so the answer time does not tell how much of a signature matched. */
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false
  let diff = 0
  for (let i = 0; i < a.length; i++)
    diff |= a[i]! ^ b[i]!
  return diff === 0
}

/**
 * Checks a webhook and returns its event. Pass the **raw body**, exactly as received, before
 * any JSON parsing. Throws `WebhookVerificationError` when the signature or timestamp is wrong.
 *
 * @param secret The webhook's signing secret (`whsec_…`, from its menu → Signing secret).
 */
export async function verifyWebhook(
  payload: WebhookPayload,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
  const id = header(headers, 'webhook-id')
  const timestamp = header(headers, 'webhook-timestamp')
  const signatures = header(headers, 'webhook-signature')
  if (!id || !timestamp || !signatures)
    throw new WebhookVerificationError('Missing webhook-id, webhook-timestamp or webhook-signature header')
  if (!/^\d+$/.test(timestamp))
    throw new WebhookVerificationError('Invalid webhook-timestamp header')
  const now = (options.now ?? new Date()).getTime() / 1000
  if (Math.abs(now - Number(timestamp)) > (options.tolerance ?? 300))
    throw new WebhookVerificationError('Webhook timestamp is too far from now')

  const key = base64ToBytes(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret)
  if (!key || key.length === 0)
    throw new WebhookVerificationError('Invalid webhook secret')
  const body = bytesOf(payload)
  const prefix = encoder.encode(`${id}.${timestamp}.`)
  const signed = new Uint8Array(prefix.length + body.length)
  signed.set(prefix)
  signed.set(body, prefix.length)

  const hmacKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, signed as BufferSource))
  const matches = signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2)
    const got = value ? base64ToBytes(value) : null
    return version === 'v1' && got !== null && equal(got, expected)
  })
  if (!matches)
    throw new WebhookVerificationError('No matching webhook signature')

  return JSON.parse(typeof payload === 'string' ? payload : decoder.decode(body)) as WebhookEvent
}
