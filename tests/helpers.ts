import 'dotenv/config'
import { getPool } from '../src/db/pool.js'
import { migrate } from '../src/db/migrate.js'
import type { ContactRow, LinkPrecedence } from '../src/identify/types.js'

/**
 * Guard against a test run reaching a database that matters.
 *
 * `resetDatabase` truncates, and a truncate pointed at the wrong connection string is
 * not recoverable, so the suite refuses to start unless the database name looks like a
 * test database.
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? ''
  if (url === '') {
    throw new Error('DATABASE_URL is not set. Run: docker compose up -d')
  }
  const name = url.split('/').pop()?.split('?')[0] ?? ''
  if (!/identity|test/i.test(name)) {
    throw new Error(
      `Refusing to run the suite against database "${name}". ` +
        'Point DATABASE_URL at a disposable database whose name contains "identity" or "test".'
    )
  }
}

export async function prepareDatabase(): Promise<void> {
  assertTestDatabase()
  await migrate()
}

export async function resetDatabase(): Promise<void> {
  assertTestDatabase()
  await getPool().query('TRUNCATE contact RESTART IDENTITY CASCADE')
}

/** Inserts a row with an explicit timestamp, so ordering rules can be tested. */
export async function seedContact(row: {
  email?: string | null
  phoneNumber?: string | null
  linkedId?: number | null
  linkPrecedence: LinkPrecedence
  createdAt: string
}): Promise<number> {
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO contact (email, phone_number, linked_id, link_precedence,
                          created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING id`,
    [
      row.email ?? null,
      row.phoneNumber ?? null,
      row.linkedId ?? null,
      row.linkPrecedence,
      row.createdAt
    ]
  )
  return (rows[0] as { id: number }).id
}

export async function readContact(id: number): Promise<ContactRow> {
  const { rows } = await getPool().query(
    `SELECT id, phone_number AS "phoneNumber", email, linked_id AS "linkedId",
            link_precedence AS "linkPrecedence", created_at AS "createdAt",
            updated_at AS "updatedAt", deleted_at AS "deletedAt"
       FROM contact WHERE id = $1`,
    [id]
  )
  if (rows[0] === undefined) throw new Error(`contact ${id} not found`)
  return rows[0] as ContactRow
}

export async function countRows(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>('SELECT count(*)::text AS n FROM contact')
  return Number((rows[0] as { n: string }).n)
}
