// Against a real Lystok API; skipped unless LYSTOK_LIVE=1. Needs a full-access key and a sender
// on a verified domain of that account:
//   LYSTOK_LIVE=1 LYSTOK_API_KEY=lk_… LYSTOK_BASE_URL=http://localhost:3200 \
//   LYSTOK_TEST_FROM=hello@your-domain LYSTOK_TEST_TO=you@your-domain npm test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Lystok, LystokError } from '../dist/index.js'

const env = process.env
const live = env.LYSTOK_LIVE === '1'

describe('live API', { skip: !live && 'set LYSTOK_LIVE=1 to run' }, () => {
  const lystok = new Lystok(env.LYSTOK_API_KEY, { baseUrl: env.LYSTOK_BASE_URL })
  const from = env.LYSTOK_TEST_FROM
  const to = env.LYSTOK_TEST_TO

  it('sends an email and reads it back', async () => {
    const { id } = await lystok.emails.send({ from, to, subject: 'lystok-js live test', html: '<p>Hello from lystok-js</p>', tags: { sdk: 'js' } })
    const email = await lystok.emails.get(id)
    assert.equal(email.id, id)
    assert.equal(email.to, to)
    assert.deepEqual(email.tags, { sdk: 'js' })
  })

  it('sends once for one idempotency key', async () => {
    const key = `lystok-js-${Date.now()}`
    const email = { from, to, subject: 'lystok-js idempotency', text: 'Once' }
    const first = await lystok.emails.send(email, { idempotencyKey: key })
    const second = await lystok.emails.send(email, { idempotencyKey: key })
    assert.equal(first.id, second.id)
  })

  it('sends a batch', async () => {
    const { data } = await lystok.emails.sendBatch([
      { from, to, subject: 'lystok-js batch 1', text: 'One' },
      { from, to, subject: 'lystok-js batch 2', text: 'Two' },
    ])
    assert.equal(data.length, 2)
  })

  it('refuses a bad address with a validation error', async () => {
    const err = await lystok.emails.send({ from, to: 'not-an-address', subject: 's', text: 't' }).catch(e => e)
    assert.ok(err instanceof LystokError)
    assert.equal(err.status, 400)
    assert.equal(err.code, 'validation')
    assert.ok(err.message)
    assert.ok(err.requestId)
  })

  it('keeps a contact in step', async () => {
    const email = `lystok-js-${Date.now()}@example.com`
    const made = await lystok.contacts.upsert({ email, first_name: 'Olena', tags: ['sdk-test'], consent_source: 'lystok-js live test' })
    assert.equal(made.status, 'subscribed')
    assert.deepEqual(made.tags, ['sdk-test'])
    const changed = await lystok.contacts.update(email, { last_name: 'Shevchenko', remove_tags: ['sdk-test'] })
    assert.equal(changed.last_name, 'Shevchenko')
    assert.deepEqual(changed.tags, [])
    assert.equal((await lystok.contacts.get(made.id)).email, email)
    await lystok.contacts.delete(made.id)
    const err = await lystok.contacts.get(email).catch(e => e)
    assert.equal(err.status, 404)
  })
})
