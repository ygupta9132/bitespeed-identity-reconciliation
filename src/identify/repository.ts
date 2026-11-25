/**
 * Every statement this service runs, in one file, so the SQL is reviewable in one read.
 *
 * Written as explicit parameterised SQL rather than through an ORM. The whole service
 * is five queries, and two of them turn on semantics an ORM hides: `FOR UPDATE` and
 * `pg_advisory_xact_lock`. Keeping the SQL visible is also a habit from a production
 * bug where an ORM rendered a correlated subquery's column unqualified and silently
 * bound it to the wrong table, which no amount of reading the TypeScript would show.
 */
import type { PoolClient } from 'pg'
import type { ContactRow, IdentifyInput, LinkPrecedence } from './types.js'

const COLUMNS = `id, phone_number, email, linked_id, link_precedence,
                 created_at, updated_at, deleted_at`

type RawRow = {
  id: number
  phone_number: string | null
  email: string | null
  linked_id: number | null
  link_precedence: LinkPrecedence
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

function toContact(row: RawRow): ContactRow {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    email: row.email,
    linkedId: row.linked_id,
    linkPrecedence: row.link_precedence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  }
}

/**
 * Serialises requests that could touch the same customer.
 *
 * Without this, two simultaneous requests for an unseen pair both see no match and both
 * insert a primary, which splits one customer in two. The lock is taken on each
 * identifier present, prefixed so an email can never collide with a phone number, and
 * the keys are sorted so two requests holding one key each can never wait on each other.
 *
 * It is a transaction-scoped lock, so it is released by COMMIT or ROLLBACK and nothing
 * needs to unlock it on an error path.
 */
export async function lockIdentifiers(
  client: PoolClient,
  input: IdentifyInput
): Promise<void> {
  const keys: string[] = []
  if (input.email !== null) keys.push(`email:${input.email}`)
  if (input.phoneNumber !== null) keys.push(`phone:${input.phoneNumber}`)
  keys.sort()

  for (const key of keys) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
  }
}

/** Rows sharing the email or the phone number. The entry point to the cluster. */
export async function findDirectMatches(
  client: PoolClient,
  input: IdentifyInput
): Promise<ContactRow[]> {
  const { rows } = await client.query<RawRow>(
    `SELECT ${COLUMNS}
       FROM contact
      WHERE deleted_at IS NULL
        AND ( ($1::text IS NOT NULL AND email        = $1)
           OR ($2::text IS NOT NULL AND phone_number = $2) )`,
    [input.email, input.phoneNumber]
  )
  return rows.map(toContact)
}

/**
 * Loads every row belonging to the given primaries, locking them for the transaction.
 *
 * `FOR UPDATE` matters because the next thing we do is demote some of these rows. The
 * advisory lock already keeps requests that share an identifier apart; this covers the
 * case where two requests reach the same cluster through two different identifiers.
 */
export async function loadClusterForUpdate(
  client: PoolClient,
  primaryIds: readonly number[]
): Promise<ContactRow[]> {
  if (primaryIds.length === 0) return []

  const { rows } = await client.query<RawRow>(
    `SELECT ${COLUMNS}
       FROM contact
      WHERE deleted_at IS NULL
        AND (id = ANY($1::int[]) OR linked_id = ANY($1::int[]))
      ORDER BY created_at, id
        FOR UPDATE`,
    [[...primaryIds]]
  )
  return rows.map(toContact)
}

/** Same read without the lock, for building the response after the writes. */
export async function loadCluster(
  client: PoolClient,
  primaryId: number
): Promise<ContactRow[]> {
  const { rows } = await client.query<RawRow>(
    `SELECT ${COLUMNS}
       FROM contact
      WHERE deleted_at IS NULL
        AND (id = $1 OR linked_id = $1)
      ORDER BY created_at, id`,
    [primaryId]
  )
  return rows.map(toContact)
}

export async function insertPrimary(
  client: PoolClient,
  input: IdentifyInput
): Promise<ContactRow> {
  const { rows } = await client.query<RawRow>(
    `INSERT INTO contact (email, phone_number, linked_id, link_precedence)
          VALUES ($1, $2, NULL, 'primary')
       RETURNING ${COLUMNS}`,
    [input.email, input.phoneNumber]
  )
  return toContact(rows[0] as RawRow)
}

export async function insertSecondary(
  client: PoolClient,
  input: IdentifyInput,
  primaryId: number
): Promise<ContactRow> {
  const { rows } = await client.query<RawRow>(
    `INSERT INTO contact (email, phone_number, linked_id, link_precedence)
          VALUES ($1, $2, $3, 'secondary')
       RETURNING ${COLUMNS}`,
    [input.email, input.phoneNumber, primaryId]
  )
  return toContact(rows[0] as RawRow)
}

/**
 * Demotes a primary and re-parents everything that pointed at it, in two statements.
 *
 * The second statement is the one that is easy to forget. If the losing primary had
 * secondaries of its own and they are left pointing at it, the cluster becomes a
 * two-level chain: the response for the surviving primary would not include them, and
 * a later request arriving through one of those rows would resolve to a primary that
 * is no longer primary. The brief's merge example happens to show a losing primary with
 * no children, so a reading of it that only handles that case passes the example and
 * is still wrong.
 *
 * Children are re-pointed first, while `linked_id` still identifies them.
 */
export async function demotePrimary(
  client: PoolClient,
  losingPrimaryId: number,
  survivorId: number
): Promise<void> {
  await client.query(
    `UPDATE contact
        SET linked_id  = $2,
            updated_at = now()
      WHERE linked_id  = $1
        AND deleted_at IS NULL`,
    [losingPrimaryId, survivorId]
  )

  await client.query(
    `UPDATE contact
        SET link_precedence = 'secondary',
            linked_id       = $2,
            updated_at      = now()
      WHERE id = $1
        AND deleted_at IS NULL`,
    [losingPrimaryId, survivorId]
  )
}
