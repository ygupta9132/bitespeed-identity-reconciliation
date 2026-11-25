import { describe, expect, it } from 'vitest'
import { normaliseIdentifyBody } from '../src/identify/normalise.js'
import { BadRequestError } from '../src/identify/errors.js'

describe('normaliseIdentifyBody', () => {
  it('accepts an email and a phone number', () => {
    expect(normaliseIdentifyBody({ email: 'a@b.com', phoneNumber: '123456' }))
      .toEqual({ email: 'a@b.com', phoneNumber: '123456' })
  })

  it('accepts a phone number sent as a JSON number, as the brief types it', () => {
    expect(normaliseIdentifyBody({ phoneNumber: 123456 }))
      .toEqual({ email: null, phoneNumber: '123456' })
  })

  it('accepts an explicit null for the other field', () => {
    expect(normaliseIdentifyBody({ email: null, phoneNumber: '123456' }))
      .toEqual({ email: null, phoneNumber: '123456' })
  })

  it('treats a blank string as absent', () => {
    expect(normaliseIdentifyBody({ email: '   ', phoneNumber: '123456' }))
      .toEqual({ email: null, phoneNumber: '123456' })
  })

  it('trims, and otherwise leaves the value exactly as sent', () => {
    expect(normaliseIdentifyBody({ email: '  Lorraine@hillvalley.edu  ' }))
      .toEqual({ email: 'Lorraine@hillvalley.edu', phoneNumber: null })
  })

  it('rejects a request with neither field', () => {
    expect(() => normaliseIdentifyBody({})).toThrow(BadRequestError)
    expect(() => normaliseIdentifyBody({ email: null, phoneNumber: null }))
      .toThrow(BadRequestError)
  })

  it('rejects a body that is not an object', () => {
    for (const body of [null, 'x', 42, ['a@b.com']]) {
      expect(() => normaliseIdentifyBody(body)).toThrow(BadRequestError)
    }
  })

  it('rejects a field of the wrong type', () => {
    expect(() => normaliseIdentifyBody({ email: { a: 1 } })).toThrow(BadRequestError)
    expect(() => normaliseIdentifyBody({ phoneNumber: true })).toThrow(BadRequestError)
  })

  it('rejects a fractional phone number rather than mangling it', () => {
    expect(() => normaliseIdentifyBody({ phoneNumber: 12.34 })).toThrow(BadRequestError)
  })
})
