import 'dotenv/config'
import { getPool, closePool } from './pool.js'

/**
 * Schema as one idempotent script, run on every boot.
 *
 * A single table does not need a migration tool, and running this at startup means a
 * fresh Render deploy against an empty Neon database comes up working rather than
 * 500ing until someone remembers to run a command.
 */
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS contact (
     id              SERIAL PRIMARY KEY,
     phone_number    TEXT,
     email           TEXT,
     linked_id       INTEGER REFERENCES contact (id),
     link_precedence TEXT        NOT NULL,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
     deleted_at      TIMESTAMPTZ
   )`,

  // The three constraints below are what stop a bad row existing at all, rather than
  // relying on the service always being correct.
  `DO $$ BEGIN
     ALTER TABLE contact ADD CONSTRAINT contact_precedence_values
       CHECK (link_precedence IN ('primary', 'secondary'));
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  `DO $$ BEGIN
     ALTER TABLE contact ADD CONSTRAINT contact_has_an_identifier
       CHECK (email IS NOT NULL OR phone_number IS NOT NULL);
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // A primary never points anywhere; a secondary always points somewhere. This is what
  // makes an orphaned secondary, and a primary that thinks it has a parent, unstorable.
  `DO $$ BEGIN
     ALTER TABLE contact ADD CONSTRAINT contact_link_shape
       CHECK (
         (link_precedence = 'primary'   AND linked_id IS NULL) OR
         (link_precedence = 'secondary' AND linked_id IS NOT NULL)
       );
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  `CREATE INDEX IF NOT EXISTS contact_email_idx
     ON contact (email) WHERE deleted_at IS NULL`,

  `CREATE INDEX IF NOT EXISTS contact_phone_number_idx
     ON contact (phone_number) WHERE deleted_at IS NULL`,

  `CREATE INDEX IF NOT EXISTS contact_linked_id_idx
     ON contact (linked_id) WHERE deleted_at IS NULL`,

  /*
   * The invariant that makes a duplicate row impossible rather than unlikely.
   *
   * COALESCE rather than a plain unique index on (email, phone_number), because two
   * NULLs are distinct to Postgres, so ('a@b.com', NULL) could otherwise be inserted
   * twice. With the service's locking this index should never fire; it is here so that
   * if the locking is ever wrong, the second insert fails loudly instead of quietly
   * splitting one customer into two.
   */
  `CREATE UNIQUE INDEX IF NOT EXISTS contact_identity_uniq
     ON contact (COALESCE(email, ''), COALESCE(phone_number, ''))
     WHERE deleted_at IS NULL`
]

export async function migrate(): Promise<void> {
  const client = await getPool().connect()
  try {
    for (const statement of STATEMENTS) {
      await client.query(statement)
    }
  } finally {
    client.release()
  }
}

// Run directly: `npm run migrate`.
// Matching on the bare filename avoids caring whether the platform handed us forward
// or back slashes in argv[1].
const entry = process.argv[1] ?? ''
const invokedDirectly = entry.endsWith('migrate.ts') || entry.endsWith('migrate.js')

if (invokedDirectly) {
  migrate()
    .then(() => console.log('migrate: schema is up to date'))
    .catch((error) => {
      console.error('migrate failed', error)
      process.exitCode = 1
    })
    .finally(closePool)
}
