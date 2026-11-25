import { Pool } from 'pg'

let pool: Pool | null = null

/**
 * One lazily created pool for the process.
 *
 * Lazy because `migrate.ts`, the server and the test suite all import this module, and
 * a pool constructed at import time would open sockets during a `--help` run or a unit
 * test that never touches the database.
 */
export function getPool(): Pool {
  if (pool !== null) return pool

  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.')
  }

  pool = new Pool({
    connectionString,
    // Neon and Render both terminate TLS at the proxy with a certificate this client
    // cannot chain to a local root, so verification is turned off rather than the
    // whole of TLS. Set PGSSLMODE=disable for a plaintext local Postgres.
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  })

  pool.on('error', (error) => {
    console.error('[pg] idle client error', error)
  })

  return pool
}

export async function closePool(): Promise<void> {
  if (pool === null) return
  const closing = pool
  pool = null
  await closing.end()
}
