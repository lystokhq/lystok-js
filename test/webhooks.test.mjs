import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { Lystok, verifyWebhook, WebhookVerificationError } from '../dist/index.js'

// Signed by the Lystok platform itself, so passing them means accepting exactly what it sends.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/webhooks.json', import.meta.url), 'utf8'))

describe('verifyWebhook: platform test cases', () => {
  for (const c of fixtures.cases) {
    it(c.name, async () => {
      const verify = verifyWebhook(c.payload, c.headers, c.secret, { now: new Date(c.now * 1000) })
      if (c.valid)
        assert.deepEqual(await verify, JSON.parse(c.payload))
      else
        await assert.rejects(verify, WebhookVerificationError)
    })
  }
})

describe('verifyWebhook: inputs', () => {
  const c = fixtures.cases.find(x => x.name === 'valid')
  const now = new Date(c.now * 1000)

  it('takes the body as bytes (Buffer, Uint8Array, ArrayBuffer)', async () => {
    const bytes = new TextEncoder().encode(c.payload)
    for (const payload of [Buffer.from(c.payload), bytes, bytes.buffer])
      assert.equal((await verifyWebhook(payload, c.headers, c.secret, { now })).type, 'email.delivered')
  })

  it('takes a Headers object and header names in any case', async () => {
    const upper = Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.toUpperCase(), v]))
    assert.ok(await verifyWebhook(c.payload, new Headers(c.headers), c.secret, { now }))
    assert.ok(await verifyWebhook(c.payload, upper, c.secret, { now }))
  })

  it('refuses a secret that is not base64', async () => {
    await assert.rejects(verifyWebhook(c.payload, c.headers, 'whsec_not base64!', { now }), WebhookVerificationError)
  })

  it('is on the client too', async () => {
    const lystok = new Lystok('lk_test_x')
    assert.equal((await lystok.webhooks.verify(c.payload, c.headers, c.secret, { now })).type, 'email.delivered')
  })
})
