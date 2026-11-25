import { describe, expect, it } from 'vitest'
import {
  buildResponse,
  chooseSurvivingPrimary,
  needsNewSecondary,
  primariesToDemote
} from '../src/identify/link.js'
import { InvariantError } from '../src/identify/errors.js'
import type { ContactRow, LinkPrecedence } from '../src/identify/types.js'

function row(p: {
  id: number
  email?: string | null
  phoneNumber?: string | null
  linkedId?: number | null
  linkPrecedence?: LinkPrecedence
  createdAt: string
}): ContactRow {
  const created = new Date(p.createdAt)
  return {
    id: p.id,
    email: p.email ?? null,
    phoneNumber: p.phoneNumber ?? null,
    linkedId: p.linkedId ?? null,
    linkPrecedence: p.linkPrecedence ?? 'primary',
    createdAt: created,
    updatedAt: created,
    deletedAt: null
  }
}

describe('chooseSurvivingPrimary', () => {
  it('keeps the oldest primary, as the merge example in the brief requires', () => {
    // Brief: contact 11 (2023-04-11) survives, contact 27 (2023-04-21) is demoted.
    const cluster = [
      row({ id: 27, email: 'biffsucks@hillvalley.edu', phoneNumber: '717171', createdAt: '2023-04-21T05:30:00Z' }),
      row({ id: 11, email: 'george@hillvalley.edu', phoneNumber: '919191', createdAt: '2023-04-11T00:00:00Z' })
    ]
    expect(chooseSurvivingPrimary(cluster).id).toBe(11)
  })

  it('breaks a timestamp tie on the lower id, so the choice is deterministic', () => {
    const cluster = [
      row({ id: 9, createdAt: '2023-04-01T00:00:00Z', email: 'b@x.com' }),
      row({ id: 4, createdAt: '2023-04-01T00:00:00Z', email: 'a@x.com' })
    ]
    expect(chooseSurvivingPrimary(cluster).id).toBe(4)
  })

  it('ignores secondaries when picking the survivor', () => {
    const cluster = [
      row({ id: 5, createdAt: '2023-01-01T00:00:00Z', linkPrecedence: 'secondary', linkedId: 8 }),
      row({ id: 8, createdAt: '2023-02-01T00:00:00Z' })
    ]
    expect(chooseSurvivingPrimary(cluster).id).toBe(8)
  })

  it('refuses a cluster with no primary rather than guessing', () => {
    const cluster = [row({ id: 5, createdAt: '2023-01-01T00:00:00Z', linkPrecedence: 'secondary', linkedId: 8 })]
    expect(() => chooseSurvivingPrimary(cluster)).toThrow(InvariantError)
  })
})

describe('primariesToDemote', () => {
  it('returns every primary except the survivor, oldest first', () => {
    const cluster = [
      row({ id: 1, createdAt: '2023-01-01T00:00:00Z' }),
      row({ id: 2, createdAt: '2023-03-01T00:00:00Z' }),
      row({ id: 3, createdAt: '2023-02-01T00:00:00Z' }),
      row({ id: 4, createdAt: '2023-04-01T00:00:00Z', linkPrecedence: 'secondary', linkedId: 1 })
    ]
    expect(primariesToDemote(cluster, 1).map((r) => r.id)).toEqual([3, 2])
  })

  it('returns nothing when the cluster has a single primary', () => {
    const cluster = [row({ id: 1, createdAt: '2023-01-01T00:00:00Z' })]
    expect(primariesToDemote(cluster, 1)).toEqual([])
  })
})

describe('needsNewSecondary', () => {
  const cluster = [
    row({ id: 1, email: 'lorraine@hillvalley.edu', phoneNumber: '123456', createdAt: '2023-04-01T00:00:00Z' }),
    row({ id: 23, email: 'mcfly@hillvalley.edu', phoneNumber: '123456', createdAt: '2023-04-20T05:30:00Z', linkPrecedence: 'secondary', linkedId: 1 })
  ]

  it('is false when both values are already in the cluster', () => {
    expect(needsNewSecondary(cluster, { email: 'mcfly@hillvalley.edu', phoneNumber: '123456' })).toBe(false)
  })

  it('is false for all three single-field variations in the brief', () => {
    expect(needsNewSecondary(cluster, { email: null, phoneNumber: '123456' })).toBe(false)
    expect(needsNewSecondary(cluster, { email: 'lorraine@hillvalley.edu', phoneNumber: null })).toBe(false)
    expect(needsNewSecondary(cluster, { email: 'mcfly@hillvalley.edu', phoneNumber: null })).toBe(false)
  })

  it('is true when the email is new', () => {
    expect(needsNewSecondary(cluster, { email: 'doc@hillvalley.edu', phoneNumber: '123456' })).toBe(true)
  })

  it('is true when the phone number is new', () => {
    expect(needsNewSecondary(cluster, { email: 'mcfly@hillvalley.edu', phoneNumber: '999999' })).toBe(true)
  })
})

describe('buildResponse', () => {
  it('puts the primary values first and lists secondaries oldest first', () => {
    const cluster = [
      row({ id: 11, email: 'george@hillvalley.edu', phoneNumber: '919191', createdAt: '2023-04-11T00:00:00Z' }),
      row({ id: 27, email: 'biffsucks@hillvalley.edu', phoneNumber: '717171', createdAt: '2023-04-21T05:30:00Z', linkPrecedence: 'secondary', linkedId: 11 })
    ]
    expect(buildResponse(cluster, 11)).toEqual({
      contact: {
        primaryContatctId: 11,
        emails: ['george@hillvalley.edu', 'biffsucks@hillvalley.edu'],
        phoneNumbers: ['919191', '717171'],
        secondaryContactIds: [27]
      }
    })
  })

  it('uses the misspelled key from the brief, which is deliberate', () => {
    const response = buildResponse([row({ id: 1, email: 'a@b.com', createdAt: '2023-01-01T00:00:00Z' })], 1)
    expect(response.contact).toHaveProperty('primaryContatctId', 1)
    expect(response.contact).not.toHaveProperty('primaryContactId')
  })

  it('reports a shared phone number once', () => {
    const cluster = [
      row({ id: 1, email: 'lorraine@hillvalley.edu', phoneNumber: '123456', createdAt: '2023-04-01T00:00:00Z' }),
      row({ id: 23, email: 'mcfly@hillvalley.edu', phoneNumber: '123456', createdAt: '2023-04-20T00:00:00Z', linkPrecedence: 'secondary', linkedId: 1 })
    ]
    expect(buildResponse(cluster, 1).contact.phoneNumbers).toEqual(['123456'])
  })

  it('drops nulls instead of emitting a hole in the array', () => {
    const cluster = [
      row({ id: 1, phoneNumber: '123456', createdAt: '2023-04-01T00:00:00Z' }),
      row({ id: 2, email: 'doc@hillvalley.edu', phoneNumber: '123456', createdAt: '2023-04-02T00:00:00Z', linkPrecedence: 'secondary', linkedId: 1 })
    ]
    expect(buildResponse(cluster, 1)).toEqual({
      contact: {
        primaryContatctId: 1,
        emails: ['doc@hillvalley.edu'],
        phoneNumbers: ['123456'],
        secondaryContactIds: [2]
      }
    })
  })

  it('returns an empty secondary list for a lone primary', () => {
    const response = buildResponse([row({ id: 1, email: 'a@b.com', createdAt: '2023-01-01T00:00:00Z' })], 1)
    expect(response.contact.secondaryContactIds).toEqual([])
  })

  it('refuses to build a response whose primary is not in the cluster', () => {
    expect(() => buildResponse([row({ id: 1, email: 'a@b.com', createdAt: '2023-01-01T00:00:00Z' })], 99))
      .toThrow(InvariantError)
  })
})
