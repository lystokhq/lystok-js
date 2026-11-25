import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Lystok, LystokError, VERSION } from '../dist/index.js'

/** A fake `fetch` that answers from a list and records every request. */
function fakeFetch(...answers) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, ...init, headers: init.headers, json: init.body ? JSON.parse(init.body) : undefined })
    const answer = answers.shift()
    if (typeof answer === 'function')
      return answer(init)
    if (answer instanceof Error)
      throw answer
    const { status = 200, body, headers = {} } = answer ?? {}
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }
  fn.calls = calls
  return fn
}

/**
 * A request that never answers until it is aborted. A real one holds a socket that keeps Node
 * running; this one holds a timer, since AbortSignal.timeout alone does not (Node 20 and 22 end the
 * test with the promise still pending).
 */
function hang(init) {
  return new Promise((_, reject) => {
    const keepAlive = setInterval(() => {}, 1000)
    init.signal.addEventListener('abort', () => {
      clearInterval(keepAlive)
      reject(init.signal.reason)
    })
  })
}

const client = (fetch, options = {}) => new Lystok('lk_live_test', { fetch, baseUrl: 'https://api.example/', ...options })

describe('client', () => {
  it('needs an API key, and never reads one from the environment', async () => {
    const saved = process.env.LYSTOK_API_KEY
    process.env.LYSTOK_API_KEY = 'lk_live_from_env'
    try {
      for (const key of [undefined, '', '  '])
        assert.throws(() => new Lystok(key), /Missing API key/)
    }
    finally {
      if (saved === undefined)
        delete process.env.LYSTOK_API_KEY
      else
        process.env.LYSTOK_API_KEY = saved
    }
    const fetch = fakeFetch({ body: { id: 'e1' } })
    await new Lystok('lk_live_given', { fetch }).emails.get('e1')
    assert.equal(fetch.calls[0].headers.Authorization, 'Bearer lk_live_given')
    assert.equal(fetch.calls[0].url, 'https://api.lystok.com/v1/emails/e1')
  })

  it('sends an email with the key, JSON, a version and a made-up idempotency key', async () => {
    const fetch = fakeFetch({ body: { id: '019ab3f2' } })
    const email = { from: 'Shop <orders@shop.example>', to: 'olena@example.com', subject: 'Hi', html: '<p>Hi</p>', tags: { type: 'order' } }
    assert.deepEqual(await client(fetch).emails.send(email), { id: '019ab3f2' })
    const [call] = fetch.calls
    assert.equal(call.url, 'https://api.example/v1/emails')
    assert.equal(call.method, 'POST')
    assert.deepEqual(call.json, email)
    assert.equal(call.headers.Authorization, 'Bearer lk_live_test')
    assert.equal(call.headers['Content-Type'], 'application/json')
    assert.equal(call.headers['User-Agent'], `lystok-js/${VERSION}`)
    assert.match(call.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/)
  })

  it('uses the idempotency key you give', async () => {
    const fetch = fakeFetch({ body: { data: [{ id: 'a' }, { id: 'b' }] } })
    const res = await client(fetch).emails.sendBatch([{ from: 'a@x.example', to: 'b@x.example', template_id: 't' }], { idempotencyKey: 'order-1042' })
    assert.deepEqual(res.data.map(e => e.id), ['a', 'b'])
    assert.equal(fetch.calls[0].url, 'https://api.example/v1/emails/batch')
    assert.equal(fetch.calls[0].headers['Idempotency-Key'], 'order-1042')
  })

  it('works with contacts by id or by address', async () => {
    const contact = { id: 'c1', email: 'olena@example.com' }
    const fetch = fakeFetch({ status: 201, body: contact }, { body: contact }, { body: contact }, { status: 204 })
    const lystok = client(fetch)
    assert.deepEqual(await lystok.contacts.upsert({ email: 'olena@example.com', consent_source: 'Checkout' }), contact)
    await lystok.contacts.get('olena+shop@example.com')
    await lystok.contacts.update('c1', { remove_tags: ['old'], status: 'unsubscribed' })
    assert.equal(await lystok.contacts.delete('c1'), undefined)
    assert.deepEqual(fetch.calls.map(c => `${c.method} ${c.url}`), [
      'POST https://api.example/v1/contacts',
      'GET https://api.example/v1/contacts/olena%2Bshop%40example.com',
      'PATCH https://api.example/v1/contacts/c1',
      'DELETE https://api.example/v1/contacts/c1',
    ])
    assert.equal(fetch.calls[0].headers['Idempotency-Key'], undefined)
    assert.equal(fetch.calls[1].headers['Content-Type'], undefined)
  })
})

describe('errors', () => {
  it('turns an error answer into LystokError', async () => {
    const fetch = fakeFetch({
      status: 422,
      body: { error: { code: 'validation', message: '`to` is not a valid email address.', params: { field: 'to' }, issues: [{ path: 'to', message: 'Invalid email' }], requestId: 'req_1' } },
    })
    const err = await client(fetch).emails.send({ from: 'a@x.example', to: 'nope' }).catch(e => e)
    assert.ok(err instanceof LystokError)
    assert.equal(err.status, 422)
    assert.equal(err.code, 'validation')
    assert.equal(err.message, '`to` is not a valid email address.')
    assert.deepEqual(err.params, { field: 'to' })
    assert.deepEqual(err.issues, [{ path: 'to', message: 'Invalid email' }])
    assert.equal(err.requestId, 'req_1')
    assert.equal(fetch.calls.length, 1, 'a refused request is not tried again')
  })

  it('copes with an answer that is not JSON', async () => {
    const fetch = fakeFetch(() => new Response('<html>Bad gateway</html>', { status: 502 }))
    const err = await client(fetch, { maxRetries: 0 }).emails.get('e1').catch(e => e)
    assert.equal(err.status, 502)
    assert.equal(err.code, 'server_error')
  })
})

describe('retries', () => {
  it('tries again after 503 with the same idempotency key', async () => {
    const fetch = fakeFetch({ status: 503, body: { error: { code: 'unavailable', requestId: 'r' } } }, { body: { id: 'e1' } })
    assert.deepEqual(await client(fetch).emails.send({ from: 'a@x.example', to: 'b@x.example', subject: 's', html: 'h' }), { id: 'e1' })
    assert.equal(fetch.calls.length, 2)
    assert.equal(fetch.calls[0].headers['Idempotency-Key'], fetch.calls[1].headers['Idempotency-Key'])
  })

  it('waits Retry-After on 429', async () => {
    const fetch = fakeFetch({ status: 429, body: { error: { code: 'rate_limited', requestId: 'r' } }, headers: { 'retry-after': '1' } }, { body: { id: 'e1' } })
    const started = Date.now()
    await client(fetch).emails.get('e1')
    assert.ok(Date.now() - started >= 950)
  })

  it('tries again while the same idempotency key is still being handled', async () => {
    const fetch = fakeFetch({ status: 409, body: { error: { code: 'idempotency_in_progress', requestId: 'r' } } }, { body: { id: 'e1' } })
    assert.deepEqual(await client(fetch).emails.send({ from: 'a@x.example', to: 'b@x.example', template_id: 't' }), { id: 'e1' })
  })

  it('gives up after maxRetries and says the connection failed', async () => {
    const fetch = fakeFetch(new TypeError('fetch failed'), new TypeError('fetch failed'))
    const err = await client(fetch, { maxRetries: 1 }).emails.get('e1').catch(e => e)
    assert.ok(err instanceof LystokError)
    assert.equal(err.status, 0)
    assert.equal(err.code, 'connection_error')
    assert.equal(fetch.calls.length, 2)
  })

  it('stops a slow request at the timeout', async () => {
    const err = await client(fakeFetch(hang), { timeout: 50, maxRetries: 0 }).emails.get('e1').catch(e => e)
    assert.equal(err.code, 'timeout')
  })

  it('does not try again when you cancel', async () => {
    const controller = new AbortController()
    const fetch = fakeFetch(hang, hang)
    const pending = client(fetch).emails.get('e1', { signal: controller.signal })
    controller.abort()
    await assert.rejects(pending, e => e.name === 'AbortError')
    assert.equal(fetch.calls.length, 1)
  })

  it('a delete that went through before the network failed is done', async () => {
    const fetch = fakeFetch(new TypeError('fetch failed'), { status: 404, body: { error: { code: 'not_found', requestId: 'r' } } })
    assert.equal(await client(fetch).contacts.delete('c1'), undefined)
  })
})
