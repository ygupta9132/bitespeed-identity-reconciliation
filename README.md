# Identity Reconciliation

A service that recognises one customer across orders placed with different email addresses
and phone numbers, for the Bitespeed backend task.

## Hosted endpoint

```
POST https://REPLACE-ME.onrender.com/identify
```

> **Not yet deployed.** Replace the host above once the Render service is live. The
> instance runs on Render's free tier, which sleeps after inactivity, so **the first
> request after an idle period can take up to a minute** while the container wakes.
> A cold start is not an outage. `GET /health` is the cheapest way to wake it.

```bash
curl -X POST https://REPLACE-ME.onrender.com/identify \
  -H 'Content-Type: application/json' \
  -d '{"email":"mcfly@hillvalley.edu","phoneNumber":"123456"}'
```

## Contract

`POST /identify`, JSON body, both fields optional but **at least one required**:

```ts
{ "email"?: string | null, "phoneNumber"?: string | number | null }
```

Returns HTTP 200 and the consolidated contact:

```ts
{
  "contact": {
    "primaryContatctId": number,
    "emails": string[],              // the primary's email first
    "phoneNumbers": string[],        // the primary's phone number first
    "secondaryContactIds": number[]  // every secondary linked to that primary
  }
}
```

HTTP 400 when neither identifier is present, when a field is the wrong type, or when the
body is not valid JSON. There is also `GET /health`, which touches the database, so a
green health check means the whole path is up rather than just Node.

### `primaryContatctId` is spelled that way on purpose

The task brief uses `primaryContatctId`, with "Contatct" transposed, in both of its
response examples. This service reproduces that key exactly, because a client written
against the brief would break if it were silently corrected. There is a test asserting
the misspelling so that nobody tidies it away later.

## Verified behaviour

Real output from the two worked examples in the brief, captured by [`smoke.sh`](smoke.sh)
against a running instance.

**A known phone number arrives with a new email,** so a secondary is created:

```jsonc
// POST {"email":"lorraine@hillvalley.edu","phoneNumber":"123456"}
{"contact":{"primaryContatctId":1,"emails":["lorraine@hillvalley.edu"],
            "phoneNumbers":["123456"],"secondaryContactIds":[]}}

// POST {"email":"mcfly@hillvalley.edu","phoneNumber":"123456"}
{"contact":{"primaryContatctId":1,
            "emails":["lorraine@hillvalley.edu","mcfly@hillvalley.edu"],
            "phoneNumbers":["123456"],"secondaryContactIds":[2]}}
```

**All three single-field variations** from the brief then return that same contact, and
none of them creates a row:

```jsonc
// POST {"email":null,"phoneNumber":"123456"}
// POST {"email":"lorraine@hillvalley.edu","phoneNumber":null}
// POST {"email":"mcfly@hillvalley.edu","phoneNumber":null}
{"contact":{"primaryContatctId":1,
            "emails":["lorraine@hillvalley.edu","mcfly@hillvalley.edu"],
            "phoneNumbers":["123456"],"secondaryContactIds":[2]}}
```

**Two primaries merge** and the older one survives:

```jsonc
// POST {"email":"george@hillvalley.edu","phoneNumber":"919191"}   -> primary 3
// POST {"email":"biffsucks@hillvalley.edu","phoneNumber":"717171"} -> primary 4

// POST {"email":"george@hillvalley.edu","phoneNumber":"717171"}
{"contact":{"primaryContatctId":3,
            "emails":["george@hillvalley.edu","biffsucks@hillvalley.edu"],
            "phoneNumbers":["919191","717171"],"secondaryContactIds":[4]}}
```

## How it works

One request, one transaction.

1. **Validate.** Reject a request with no identifier before touching the database.
2. **Lock.** Take a transaction-scoped advisory lock on each identifier present.
3. **Find.** Select live rows sharing the email or the phone number.
4. **No match?** Insert a primary and return it with no secondaries. Done.
5. **Resolve.** Map each match to the primary it belongs to, since a match may itself be
   a secondary. One request can reach two separate clusters, which is what makes a merge
   necessary.
6. **Load the whole cluster** for those primaries, `FOR UPDATE`.
7. **Choose the survivor:** the oldest primary.
8. **Demote** every other primary, and re-point its children at the survivor.
9. **Insert a secondary** only if the request carries information the cluster lacks.
10. **Re-read and respond,** so the payload reflects what the transaction commits.

### The rule that decides a merge

**The oldest primary survives.** The brief settles this in its own example: contact 11 was
created on 2023-04-11 and stays primary, contact 27 was created on 2023-04-21 and is
demoted. A tie on the timestamp falls back to the lower id, so the outcome is
deterministic when two rows land in the same millisecond.

### The case the brief does not illustrate

When two clusters merge, the losing primary **may already have secondaries of its own**.
The brief's example happens to show one with no children, so an implementation that
handles only that case passes the example and is still wrong: leaving those children
pointing at a row that is no longer primary produces a two-level chain, they disappear
from the response, and a later request arriving through one of them resolves to a
non-primary row.

So `demotePrimary` runs two statements, children first, while `linked_id` still
identifies them:

```sql
UPDATE contact SET linked_id = :survivor, updated_at = now()
 WHERE linked_id = :losing AND deleted_at IS NULL;

UPDATE contact SET link_precedence = 'secondary', linked_id = :survivor, updated_at = now()
 WHERE id = :losing AND deleted_at IS NULL;
```

There are tests for the merge with children, for a request arriving through a re-pointed
child afterwards, and for three clusters collapsing in a single request.

### Concurrency

Two simultaneous requests for an unseen pair would both find no match and both insert a
primary, splitting one customer in two. Three layers stop it, and they are deliberately
redundant:

| Layer | What it covers |
|---|---|
| `pg_advisory_xact_lock` per identifier, **keys sorted** | two requests sharing an email or a phone. Sorting means two requests holding one key each cannot wait on each other |
| `SELECT ... FOR UPDATE` on the cluster | two requests reaching the same cluster through *different* identifiers |
| partial unique index on the identity pair | the backstop. If the locking is ever wrong, the duplicate insert **fails loudly** instead of quietly splitting a customer |

The index uses `COALESCE`, because two `NULL`s are distinct to Postgres and
`('a@b.com', NULL)` could otherwise be stored twice:

```sql
CREATE UNIQUE INDEX contact_identity_uniq
    ON contact (COALESCE(email, ''), COALESCE(phone_number, ''))
 WHERE deleted_at IS NULL;
```

A unique violation is retried exactly once, which re-reads the cluster and returns the
same contact a serial execution would have produced. A second failure is a real bug and
is allowed to surface rather than being swallowed.

The locking is per identifier rather than global, so unrelated customers do not queue
behind each other. The ceiling is that requests touching the same customer serialise,
which is the correct trade for a write that has to be consistent.

### Constraints rather than conventions

Three `CHECK` constraints make a malformed row unstorable rather than merely unexpected:

- `contact_precedence_values` restricts `link_precedence` to the two legal values
- `contact_has_an_identifier` requires an email or a phone number
- `contact_link_shape` requires that a primary points nowhere and a secondary points
  somewhere, which is what makes an orphaned secondary impossible

Each one has a test asserting the database rejects the bad row.

## Decisions worth questioning

**`phoneNumber` accepts a string or a number.** The brief types it `number`, but every
example sends a string and the column is a nullable string. `"0123"` and `123` are
different phone numbers and only one of them survives a round trip through a JavaScript
number, so the value is stored as text. A fractional number is rejected rather than
mangled.

**Values are trimmed and otherwise stored exactly as sent.** The email is not
lower-cased and punctuation is not stripped from the phone number. The brief specifies
matching on string equality and says nothing about normalisation, so inventing it here
would store something the caller did not send. A production system should normalise, and
would then have to backfill the existing rows to match, which is the part that makes it a
migration rather than a one-line change.

**Explicit SQL rather than an ORM.** The whole service is five queries, and two of them
turn on semantics an ORM hides behind an escape hatch anyway: `FOR UPDATE` and the
advisory lock. Keeping the SQL visible is also a habit from a production bug where an ORM
rendered a correlated subquery's column unqualified, Postgres bound it to the inner table,
and the query silently returned zeros for a year. Nothing in the TypeScript showed it.

**The schema script runs on every boot.** One table does not need a migration tool, and
running it at startup means a fresh deploy against an empty database comes up serving
requests rather than returning 500s until someone remembers a command.

**`deleted_at` is honoured but never written.** The brief's schema includes it, so every
read filters on it and the indexes are partial. Nothing in the task deletes a contact, so
no delete path was invented.

## Running it locally

```bash
cp .env.example .env     # defaults match the compose file below
docker compose up -d     # Postgres 16 on localhost:5434
npm install
npm run migrate
npm run dev              # http://localhost:3000
./smoke.sh               # replays both worked examples from the brief
```

Port 5434 rather than 5432, because 5432 is usually taken by a local install and a test
suite that truncates tables should never be able to reach the wrong database.

## Tests

```bash
npm test                 # 49 tests
npm run test:unit        # the 25 that need no database
npm run typecheck
```

**49 tests, all passing.** The split is deliberate: the rules that decide a customer's
identity are pure functions over rows already loaded, so each one is tested without a
database, and the integration suite then proves the transaction and the SQL.

| Suite | Covers |
|---|---|
| `tests/normalise.spec.ts` (9) | request validation, the string-or-number phone, blank and absent fields |
| `tests/link.spec.ts` (16) | survivor choice and its tie-break, the new-information rule, response ordering and dedupe, the misspelled key |
| `tests/identify.spec.ts` (24) | both worked examples, the merge with children, a request through a re-pointed child, three clusters at once, idempotent repeats, bad requests, the `CHECK` constraints, and two concurrency tests |

The concurrency tests are the ones worth reading. One fires the same new customer at the
service **eight times at once** and asserts exactly one row exists afterwards and that
every caller was told the same primary id. The other sends two new emails on one known
phone number simultaneously and asserts the customer was not split.

The suite truncates tables, so `tests/helpers.ts` refuses to run unless the database name
contains `identity` or `test`.

## Deployment

The app is on Render's free tier and the database on **Neon**, not Render Postgres.
Render's free Postgres expires after 30 days, which would leave the endpoint at the top
of this file returning 500s a month after submission. [`render.yaml`](render.yaml) is the
blueprint and declares no database for that reason; `DATABASE_URL` is set in the Render
dashboard. There is also a multi-stage [`Dockerfile`](Dockerfile) if you would rather run
it as a container.

## Layout

```
src/
  index.ts                  server bootstrap, runs the schema script then listens
  app.ts                    express wiring, error handling, /health
  db/
    pool.ts                 lazily created pg pool
    migrate.ts              the schema, as one idempotent script
  identify/
    types.ts                row and response shapes
    errors.ts               BadRequestError, InvariantError
    normalise.ts            untrusted body to a validated input
    link.ts                 the decision rules, pure
    repository.ts           every SQL statement, in one file
    service.ts              the transaction
tests/                      49 tests
smoke.sh                    replays the brief's examples against a running service
```
