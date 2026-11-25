/**
 * The decision rules, as pure functions over rows that are already loaded.
 *
 * Everything here is deterministic and has no database access, so each rule that
 * decides what happens to a customer's identity is testable on its own. The ordering
 * rule in particular is the one thing in this task that is easy to get subtly wrong
 * and impossible to notice from a happy-path test.
 */
import { InvariantError } from './errors.js'
import type { ContactRow, IdentifyInput, IdentifyResponse } from './types.js'

/** Oldest first, and the lower id wins a tie on the timestamp. */
export function byAge(a: ContactRow, b: ContactRow): number {
  const diff = a.createdAt.getTime() - b.createdAt.getTime()
  return diff !== 0 ? diff : a.id - b.id
}

/**
 * The surviving primary is the OLDEST primary in the cluster.
 *
 * The brief's own merge example settles this: contact 11 was created on 2023-04-11 and
 * stays primary, contact 27 was created on 2023-04-21 and is demoted. Ties on the
 * timestamp fall back to the lower id, which keeps the choice deterministic when two
 * rows are inserted inside the same millisecond.
 */
export function chooseSurvivingPrimary(cluster: readonly ContactRow[]): ContactRow {
  const primaries = cluster.filter((row) => row.linkPrecedence === 'primary')
  const survivor = [...primaries].sort(byAge)[0]

  if (survivor === undefined) {
    throw new InvariantError('Cluster contains no primary contact.')
  }
  return survivor
}

/** Every other primary in the cluster. Each one is demoted and linked to the survivor. */
export function primariesToDemote(
  cluster: readonly ContactRow[],
  survivorId: number
): ContactRow[] {
  return cluster
    .filter((row) => row.linkPrecedence === 'primary' && row.id !== survivorId)
    .sort(byAge)
}

/**
 * True when the request carries information the cluster does not already hold.
 *
 * A null field is never new information, which is what makes the three variations in
 * the brief's first example all return the same response without creating a row:
 * phone only, primary's email only, and secondary's email only.
 */
export function needsNewSecondary(
  cluster: readonly ContactRow[],
  input: IdentifyInput
): boolean {
  const emailKnown =
    input.email === null || cluster.some((row) => row.email === input.email)
  const phoneKnown =
    input.phoneNumber === null ||
    cluster.some((row) => row.phoneNumber === input.phoneNumber)

  return !(emailKnown && phoneKnown)
}

/**
 * Builds the consolidated contact.
 *
 * The primary's own email and phone come first, per the brief ("first element being
 * email of primary contact"), then the secondaries oldest first. Values are deduped
 * and nulls dropped, so a cluster where three rows share a phone number reports it
 * once.
 */
export function buildResponse(
  cluster: readonly ContactRow[],
  survivorId: number
): IdentifyResponse {
  const primary = cluster.find((row) => row.id === survivorId)
  if (primary === undefined) {
    throw new InvariantError(`Primary contact ${survivorId} is not in the cluster.`)
  }

  const secondaries = cluster.filter((row) => row.id !== survivorId).sort(byAge)
  const ordered = [primary, ...secondaries]

  return {
    contact: {
      primaryContatctId: primary.id,
      emails: distinct(ordered.map((row) => row.email)),
      phoneNumbers: distinct(ordered.map((row) => row.phoneNumber)),
      secondaryContactIds: secondaries.map((row) => row.id)
    }
  }
}

function distinct(values: readonly (string | null)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (value === null || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
