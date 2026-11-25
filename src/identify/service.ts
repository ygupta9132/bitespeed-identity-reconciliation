/**
 * The transaction. One request, one transaction, one consolidated contact out.
 */
import type { PoolClient } from 'pg'
import { getPool } from '../db/pool.js'
import {
  buildResponse,
  chooseSurvivingPrimary,
  needsNewSecondary,
  primariesToDemote
} from './link.js'
import {
  demotePrimary,
  findDirectMatches,
  insertPrimary,
  insertSecondary,
  loadCluster,
  loadClusterForUpdate,
  lockIdentifiers
} from './repository.js'
import type { ContactRow, IdentifyInput, IdentifyResponse } from './types.js'

/** Postgres unique-violation. See the note on the retry in `identify`. */
const UNIQUE_VIOLATION = '23505'

export async function identify(input: IdentifyInput): Promise<IdentifyResponse> {
  try {
    return await inTransaction(input)
  } catch (error) {
    /*
     * The one case worth a retry.
     *
     * `contact_identity_uniq` fires only if two transactions inserted the same identity
     * pair despite the advisory lock. Retrying once re-reads the cluster, finds the row
     * the other transaction committed, and returns the same consolidated contact that a
     * serial execution would have produced. A second failure is a real bug and is
     * allowed to surface.
     */
    if (isUniqueViolation(error)) {
      return await inTransaction(input)
    }
    throw error
  }
}

async function inTransaction(input: IdentifyInput): Promise<IdentifyResponse> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const response = await run(client, input)
    await client.query('COMMIT')
    return response
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function run(client: PoolClient, input: IdentifyInput): Promise<IdentifyResponse> {
  await lockIdentifiers(client, input)

  const matches = await findDirectMatches(client, input)

  // Nobody has used either identifier before: a new customer.
  if (matches.length === 0) {
    const created = await insertPrimary(client, input)
    return buildResponse([created], created.id)
  }

  // A match may itself be a secondary, so resolve each one to the primary it belongs to
  // before loading anything. A request can reach two separate clusters at once, which is
  // what makes a merge necessary.
  const primaryIds = distinctIds(
    matches.map((row) => (row.linkPrecedence === 'primary' ? row.id : (row.linkedId as number)))
  )

  const cluster = await loadClusterForUpdate(client, primaryIds)
  const survivor = chooseSurvivingPrimary(cluster)

  for (const losing of primariesToDemote(cluster, survivor.id)) {
    await demotePrimary(client, losing.id, survivor.id)
  }

  if (needsNewSecondary(cluster, input)) {
    await insertSecondary(client, input, survivor.id)
  }

  // Re-read rather than patching the in-memory rows, so the response is built from what
  // the transaction will actually commit.
  const settled = await loadCluster(client, survivor.id)
  return buildResponse(settled, survivor.id)
}

function distinctIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b)
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  )
}

export type { ContactRow, IdentifyInput, IdentifyResponse }
