# Lystok for Node.js and TypeScript

The official library for the [Lystok](https://lystok.com) email API: send transactional email,
keep contacts in step and check webhooks. No dependencies; works in Node.js 20.19+, Bun, Deno and
edge runtimes that have `fetch` and Web Crypto.

```sh
npm install lystok
```

## Send an email

Create an API key in Lystok → Settings → For developers, and verify your sender domain.

```ts
import { Lystok } from 'lystok'

const lystok = new Lystok(process.env.LYSTOK_API_KEY)

const { id } = await lystok.emails.send({
  from: 'Shop <orders@shop.example>',
  to: 'olena@example.com',
  subject: 'Your order #1042',
  html: '<p>Thank you! We are packing your order.</p>',
})
```

`new Lystok()` without a key reads `LYSTOK_API_KEY`. Keys belong on your server: never put one in
a browser or a mobile app.

### With a template

```ts
await lystok.emails.send({
  from: 'Shop <orders@shop.example>',
  to: 'olena@example.com',
  template_id: '019ab3f2-…', // Templates → ⋯ → Copy ID
  data: { first_name: 'Olena', order: { number: 1042 } },
  locale: 'uk',
})
```

### Attachments, tags, tracking

```ts
import { readFile } from 'node:fs/promises'

await lystok.emails.send({
  from: 'Shop <orders@shop.example>',
  to: 'olena@example.com',
  subject: 'Invoice #1042',
  html: '<p>Your invoice is attached.</p>',
  attachments: [{ filename: 'invoice-1042.pdf', content: (await readFile('invoice-1042.pdf')).toString('base64') }],
  tags: { type: 'invoice' },
  tracking: { opens: true, clicks: true },
})
```

### Many at once, and what happened

```ts
const { data } = await lystok.emails.sendBatch([
  { from: 'Shop <orders@shop.example>', to: 'olena@example.com', template_id: '…', data: { first_name: 'Olena' } },
  { from: 'Shop <orders@shop.example>', to: 'taras@example.com', template_id: '…', data: { first_name: 'Taras' } },
]) // up to 100; ids in the same order

const email = await lystok.emails.get(data[0].id)
email.state // 'queued' | 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed' | 'suppressed'
```

## Sending once

Every send carries an `Idempotency-Key`, so the library's own retries never send an email twice.
To be safe across your own retries too (a crashed job, a repeated webhook), pass your own key —
the same key within 24 hours gets the first answer back:

```ts
await lystok.emails.send(email, { idempotencyKey: `order-${order.id}` })
```

## Contacts

Needs a key with full access.

```ts
const contact = await lystok.contacts.upsert({
  email: 'olena@example.com',
  first_name: 'Olena',
  lists: ['Customers'],
  tags: ['bought-online'],
  consent_source: 'Newsletter checkbox at checkout', // required for a new contact
})

await lystok.contacts.get('olena@example.com') // by address or by id
await lystok.contacts.update('olena@example.com', { remove_tags: ['bought-online'], fields: { city: 'Lviv' } })
await lystok.contacts.update('olena@example.com', { status: 'unsubscribed' })
await lystok.contacts.delete(contact.id)
```

## Errors

Every failure is a `LystokError`:

```ts
import { LystokError } from 'lystok'

try {
  await lystok.emails.send(email)
}
catch (err) {
  if (err instanceof LystokError) {
    err.status // 400, 401, 403, 404, 409, 429, 5xx — or 0 when no answer came
    err.code // 'validation', 'not_found', 'plan_limit', 'access_ended', 'timeout', 'connection_error', …
    err.message // for people
    err.issues // [{ path: 'to', message: '…' }] for validation errors
    err.requestId // quote it when you write to support
  }
}
```

## Retries and timeouts

Network errors, timeouts, `429` and `5xx` are tried again twice, waiting a little longer each time
(or as long as `Retry-After` says). Each try may take 30 seconds.

```ts
const lystok = new Lystok(key, { maxRetries: 4, timeout: 10_000 })
await lystok.emails.get(id, { timeout: 5_000, signal: AbortSignal.timeout(20_000) })
```

## Webhooks

Lystok signs every webhook ([Standard Webhooks](https://www.standardwebhooks.com)). Check the
**raw body** before parsing it; `verifyWebhook` returns the event or throws
`WebhookVerificationError`. The secret (`whsec_…`) is in the webhook's menu → Signing secret.

```ts
import express from 'express'
import { verifyWebhook, WebhookVerificationError } from 'lystok'

const app = express()

app.post('/webhooks/lystok', express.raw({ type: 'application/json' }), async (req, res) => {
  let event
  try {
    event = await verifyWebhook(req.body, req.headers, process.env.LYSTOK_WEBHOOK_SECRET!)
  }
  catch (err) {
    if (err instanceof WebhookVerificationError)
      return res.sendStatus(401)
    throw err
  }
  res.sendStatus(200) // answer within 10 seconds, then do the slow work
  if (event.type === 'email.bounced') {
    // …
  }
})
```

With `Request` (Next.js route handlers, Hono, Bun, Deno, Cloudflare Workers):

```ts
export async function POST(request: Request) {
  const event = await verifyWebhook(await request.text(), request.headers, process.env.LYSTOK_WEBHOOK_SECRET!)
  // …
  return new Response(null, { status: 200 })
}
```

The same event can arrive twice: skip ones you have handled by the `webhook-id` header.

## Development

```sh
npm install
npm test            # builds, then runs the tests
LYSTOK_LIVE=1 LYSTOK_API_KEY=lk_… LYSTOK_TEST_FROM=… LYSTOK_TEST_TO=… npm test   # also against the real API
```

`test/fixtures/webhooks.json` holds webhook signatures made by the Lystok platform itself; the same
file is checked by every Lystok library.

## License

[MIT](LICENSE)
