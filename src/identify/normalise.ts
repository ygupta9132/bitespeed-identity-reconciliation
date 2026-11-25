import { BadRequestError } from './errors.js'
import type { IdentifyInput } from './types.js'

/**
 * Turns an untrusted request body into an `IdentifyInput`.
 *
 * Two deliberate decisions, both recorded in the README:
 *
 * 1. `phoneNumber` is typed `number` in the brief's request schema, but every example
 *    in the brief sends a string and the column is a nullable string. We accept either
 *    and store text, because "0123" and 123 are different phone numbers and only one of
 *    those survives a round trip through a JavaScript number.
 *
 * 2. We trim, and otherwise leave the values exactly as sent. We do not lower-case the
 *    email or strip punctuation from the phone. The brief specifies matching on string
 *    equality and says nothing about normalisation, so inventing it here would store
 *    something the caller did not send. A production system would normalise, and would
 *    have to backfill the existing rows to match.
 */
export function normaliseIdentifyBody(body: unknown): IdentifyInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('Request body must be a JSON object.')
  }

  const raw = body as Record<string, unknown>
  const email = readText(raw.email, 'email')
  const phoneNumber = readText(raw.phoneNumber, 'phoneNumber')

  if (email === null && phoneNumber === null) {
    throw new BadRequestError('At least one of "email" or "phoneNumber" is required.')
  }

  return { email, phoneNumber }
}

function readText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BadRequestError(`"${field}" must be a string, a number or null.`)
    }
    // Number.isInteger guards against 1.23e21 stringifying into exponent notation.
    if (!Number.isInteger(value)) {
      throw new BadRequestError(`"${field}" must not be a fractional number.`)
    }
    return String(value)
  }

  if (typeof value !== 'string') {
    throw new BadRequestError(`"${field}" must be a string, a number or null.`)
  }

  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
