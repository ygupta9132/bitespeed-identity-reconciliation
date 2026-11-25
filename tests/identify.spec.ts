import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { closePool } from '../src/db/pool.js'
import { countRows, prepareDatabase, readContact, resetDatabase, seedContact } from './helpers.js'

const app = createApp()

beforeAll(prepareDatabase)
beforeEach(resetDatabase)
afterAll(closePool)

function post(body: unknown) {
  return request(app).post('/identify').send(body as object)
}

describe('POST /identify - a customer nobody has seen', () => {
  it('creates a primary and returns it with no secondaries', async () => {
    const res = await post({ email: 'doc@hillvalley.edu', phoneNumber: '123456' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      contact: {
        primaryContatctId: expect.any(Number),
        emails: ['doc@hillvalley.edu'],
        phoneNumbers: ['123456'],
        secondaryContactIds: []
      }
    })

    const created = await readContact(res.body.contact.primaryContatctId)
    expect(created.linkPrecedence).toBe('primary')
    expect(created.linkedId).toBeNull()
  })

  it('accepts an email on its own', async () => {
    const res = await post({ email: 'doc@hillvalley.edu' })
    expect(res.body.contact.emails).toEqual(['doc@hillvalley.edu'])
    expect(res.body.contact.phoneNumbers).toEqual([])
  })

  it('accepts a phone number on its own', async () => {
    const res = await post({ phoneNumber: '123456' })
    expect(res.body.contact.phoneNumbers).toEqual(['123456'])
    expect(res.body.contact.emails).toEqual([])
  })
})

describe('POST /identify - the worked example from the brief', () => {
  // Existing state: one primary, lorraine@hillvalley.edu / 123456.
  beforeEach(async () => {
    await seedContact({
      email: 'lorraine@hillvalley.edu',
      phoneNumber: '123456',
      linkPrecedence: 'primary',
      createdAt: '2023-04-01T00:00:00.374Z'
    })
  })

  it('creates a secondary when a known phone arrives with a new email', async () => {
    const res = await post({ email: 'mcfly@hillvalley.edu', phoneNumber: '123456' })

    expect(res.status).toBe(200)
    expect(res.body.contact.primaryContatctId).toBe(1)
    expect(res.body.contact.emails).toEqual([
      'lorraine@hillvalley.edu',
      'mcfly@hillvalley.edu'
    ])
    expect(res.body.contact.phoneNumbers).toEqual(['123456'])
    expect(res.body.contact.secondaryContactIds).toHaveLength(1)

    const secondaryId = res.body.contact.secondaryContactIds[0] as number
    const secondary = await readContact(secondaryId)
    expect(secondary.linkPrecedence).toBe('secondary')
    expect(secondary.linkedId).toBe(1)
  })

  it('returns the same consolidated contact for all four request shapes, creating nothing extra', async () => {
    const first = await post({ email: 'mcfly@hillvalley.edu', phoneNumber: '123456' })
    const expected = first.body
    expect(await countRows()).toBe(2)

    // The brief lists these three as all returning the response above.
    const variations = [
      { email: null, phoneNumber: '123456' },
      { email: 'lorraine@hillvalley.edu', phoneNumber: null },
      { email: 'mcfly@hillvalley.edu', phoneNumber: null }
    ]

    for (const body of variations) {
      const res = await post(body)
      expect(res.body, `request ${JSON.stringify(body)}`).toEqual(expected)
    }

    expect(await countRows()).toBe(2)
  })

  it('is idempotent when the same full request is repeated', async () => {
    const first = await post({ email: 'mcfly@hillvalley.edu', phoneNumber: '123456' })
    const second = await post({ email: 'mcfly@hillvalley.edu', phoneNumber: '123456' })

    expect(second.body).toEqual(first.body)
    expect(await countRows()).toBe(2)
  })
})

describe('POST /identify - a primary turning into a secondary', () => {
  // The brief's second worked example, with its timestamps.
  beforeEach(async () => {
    await seedContact({
      email: 'george@hillvalley.edu',
      phoneNumber: '919191',
      linkPrecedence: 'primary',
      createdAt: '2023-04-11T00:00:00.374Z'
    })
    await seedContact({
      email: 'biffsucks@hillvalley.edu',
      phoneNumber: '717171',
      linkPrecedence: 'primary',
      createdAt: '2023-04-21T05:30:00.11Z'
    })
  })

  it('demotes the newer primary and merges the two clusters', async () => {
    const res = await post({ email: 'george@hillvalley.edu', phoneNumber: '717171' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      contact: {
        primaryContatctId: 1,
        emails: ['george@hillvalley.edu', 'biffsucks@hillvalley.edu'],
        phoneNumbers: ['919191', '717171'],
        secondaryContactIds: [2]
      }
    })

    const demoted = await readContact(2)
    expect(demoted.linkPrecedence).toBe('secondary')
    expect(demoted.linkedId).toBe(1)
    // The brief shows updated_at moving while created_at stays put.
    expect(demoted.updatedAt.getTime()).toBeGreaterThan(demoted.createdAt.getTime())

    // A merge is not an insert: the request brought nothing new.
    expect(await countRows()).toBe(2)
  })

  it('reaches the same end state from the other direction', async () => {
    const res = await post({ email: 'biffsucks@hillvalley.edu', phoneNumber: '919191' })
    expect(res.body.contact.primaryContatctId).toBe(1)
    expect(res.body.contact.secondaryContactIds).toEqual([2])
  })

  it('is stable once merged', async () => {
    const first = await post({ email: 'george@hillvalley.edu', phoneNumber: '717171' })
    const again = await post({ email: 'biffsucks@hillvalley.edu', phoneNumber: '919191' })
    expect(again.body).toEqual(first.body)
    expect(await countRows()).toBe(2)
  })
})

describe('POST /identify - a merge where the losing primary has its own secondaries', () => {
  /*
   * The case the brief does not illustrate, and the one that separates a correct
   * implementation from one that passes the examples.
   *
   * If the demoted primary's children are left pointing at it, the cluster becomes a
   * two-level chain: they drop out of the response, and a later request arriving
   * through one of them resolves to a row that is no longer primary.
   */
  beforeEach(async () => {
    await seedContact({
      email: 'oldest@hillvalley.edu',
      phoneNumber: '111111',
      linkPrecedence: 'primary',
      createdAt: '2023-01-01T00:00:00Z'
    })
    await seedContact({
      email: 'middle@hillvalley.edu',
      phoneNumber: '222222',
      linkPrecedence: 'primary',
      createdAt: '2023-02-01T00:00:00Z'
    })
    await seedContact({
      email: 'child@hillvalley.edu',
      phoneNumber: '222222',
      linkPrecedence: 'secondary',
      linkedId: 2,
      createdAt: '2023-03-01T00:00:00Z'
    })
  })

  it('re-points the orphaned secondaries at the surviving primary', async () => {
    const res = await post({ email: 'oldest@hillvalley.edu', phoneNumber: '222222' })

    expect(res.body).toEqual({
      contact: {
        primaryContatctId: 1,
        emails: [
          'oldest@hillvalley.edu',
          'middle@hillvalley.edu',
          'child@hillvalley.edu'
        ],
        phoneNumbers: ['111111', '222222'],
        secondaryContactIds: [2, 3]
      }
    })

    expect((await readContact(2)).linkedId).toBe(1)
    expect((await readContact(3)).linkedId).toBe(1)
    expect((await readContact(3)).linkPrecedence).toBe('secondary')
    expect(await countRows()).toBe(3)
  })

  it('still resolves correctly when the request arrives through the re-pointed child', async () => {
    await post({ email: 'oldest@hillvalley.edu', phoneNumber: '222222' })

    const res = await post({ email: 'child@hillvalley.edu' })
    expect(res.body.contact.primaryContatctId).toBe(1)
    expect(res.body.contact.secondaryContactIds).toEqual([2, 3])
  })
})

describe('POST /identify - three clusters at once', () => {
  it('collapses them onto the oldest primary in one request', async () => {
    await seedContact({ email: 'a@x.com', phoneNumber: '111', linkPrecedence: 'primary', createdAt: '2023-01-01T00:00:00Z' })
    await seedContact({ email: 'b@x.com', phoneNumber: '222', linkPrecedence: 'primary', createdAt: '2023-02-01T00:00:00Z' })
    await seedContact({ email: 'a@x.com', phoneNumber: '222', linkPrecedence: 'secondary', linkedId: 1, createdAt: '2023-02-02T00:00:00Z' })

    const res = await post({ email: 'b@x.com', phoneNumber: '111' })

    expect(res.body.contact.primaryContatctId).toBe(1)
    expect(res.body.contact.secondaryContactIds).toEqual([2, 3])
    expect((await readContact(2)).linkPrecedence).toBe('secondary')
  })
})

describe('POST /identify - bad requests', () => {
  it('rejects a request with neither identifier', async () => {
    const res = await post({ email: null, phoneNumber: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/at least one/i)
  })

  it('rejects an empty body', async () => {
    expect((await post({})).status).toBe(400)
  })

  it('rejects malformed JSON as 400 rather than 500', async () => {
    const res = await request(app)
      .post('/identify')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
    expect(res.status).toBe(400)
  })

  it('does not create anything on a rejected request', async () => {
    await post({})
    expect(await countRows()).toBe(0)
  })
})

describe('concurrency', () => {
  it('creates exactly one primary when the same new customer arrives eight times at once', async () => {
    const body = { email: 'doc@hillvalley.edu', phoneNumber: '555555' }
    const responses = await Promise.all(Array.from({ length: 8 }, () => post(body)))

    for (const res of responses) expect(res.status).toBe(200)

    // The guarantee: one row, and every caller was told the same primary id.
    expect(await countRows()).toBe(1)
    const ids = new Set(responses.map((r) => r.body.contact.primaryContatctId))
    expect(ids.size).toBe(1)
  })

  it('does not split a customer when two new emails arrive on one known phone at once', async () => {
    await seedContact({ email: 'known@hillvalley.edu', phoneNumber: '777777', linkPrecedence: 'primary', createdAt: '2023-01-01T00:00:00Z' })

    const responses = await Promise.all([
      post({ email: 'new1@hillvalley.edu', phoneNumber: '777777' }),
      post({ email: 'new2@hillvalley.edu', phoneNumber: '777777' })
    ])

    for (const res of responses) expect(res.body.contact.primaryContatctId).toBe(1)
    expect(await countRows()).toBe(3)

    const final = await post({ phoneNumber: '777777' })
    expect(final.body.contact.emails).toHaveLength(3)
    expect(final.body.contact.secondaryContactIds).toHaveLength(2)
  })
})

describe('the database refuses a malformed row', () => {
  it('will not store a primary that points at a parent', async () => {
    await expect(
      seedContact({ email: 'x@x.com', linkPrecedence: 'primary', linkedId: 1, createdAt: '2023-01-01T00:00:00Z' })
    ).rejects.toThrow(/contact_link_shape/)
  })

  it('will not store a secondary with no parent', async () => {
    await expect(
      seedContact({ email: 'x@x.com', linkPrecedence: 'secondary', createdAt: '2023-01-01T00:00:00Z' })
    ).rejects.toThrow(/contact_link_shape/)
  })

  it('will not store a row with no identifier at all', async () => {
    await expect(
      seedContact({ linkPrecedence: 'primary', createdAt: '2023-01-01T00:00:00Z' })
    ).rejects.toThrow(/contact_has_an_identifier/)
  })

  it('will not store the same identity pair twice', async () => {
    await seedContact({ email: 'dup@x.com', phoneNumber: '1', linkPrecedence: 'primary', createdAt: '2023-01-01T00:00:00Z' })
    await expect(
      seedContact({ email: 'dup@x.com', phoneNumber: '1', linkPrecedence: 'primary', createdAt: '2023-02-01T00:00:00Z' })
    ).rejects.toThrow(/contact_identity_uniq/)
  })
})

describe('service endpoints', () => {
  it('reports healthy when the database is reachable', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })

  it('returns 404 for an unknown route', async () => {
    expect((await request(app).get('/nope')).status).toBe(404)
  })
})
