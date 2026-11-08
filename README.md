# @capydb/drizzle

Drizzle ORM helpers for [CapyDB](https://capydb.dev). A thin, typed layer over
`drizzle-orm/postgres-js` + `postgres` that bakes in the connection rules a
CapyDB cell expects - so the pooled endpoint, serverless pool sizing, and the
migrations-need-the-direct-url rule are handled for you instead of learned the
hard way.

## Install

`drizzle-orm` (v1, currently the `rc` dist-tag) and `postgres` are peer
dependencies:

```bash
pnpm add @capydb/drizzle drizzle-orm@rc postgres
pnpm add -D drizzle-kit@rc
```

## Quickstart

Link your project and pull its env vars, then create the client:

```bash
capydb link
capydb env pull        # writes DATABASE_URL (pooled) and DATABASE_DIRECT_URL (direct)
capydb generate drizzle # optional: generate a Drizzle schema from the live database
```

```ts
// src/db/index.ts
import { createDb } from '@capydb/drizzle'
import { users } from './schema'

export const db = createDb()

// anywhere in your app
const rows = await db.select().from(users)
```

For drizzle v1's relational query API (`db.query.*`), define relations with
`defineRelations` and pass them in:

```ts
import { defineRelations } from 'drizzle-orm'
import * as schema from './schema'

export const relations = defineRelations(schema, (r) => ({
  users: { posts: r.many.posts() },
  posts: { author: r.one.users({ from: schema.posts.userId, to: schema.users.id }) },
}))

export const db = createDb({ relations })
const usersWithPosts = await db.query.users.findMany({ with: { posts: true } })
```

`createDb()` resolves the connection string from, in order:
`options.connectionString`, `CAPYDB_DATABASE_URL`, `DATABASE_URL`. It throws a
descriptive error at startup if none is set.

## Pooled vs direct - why two URLs

Every CapyDB cell exposes two endpoints on `*.db.capydb.dev`:

| Port | What it is | Env var | Use for |
|---|---|---|---|
| `:6432` | Transaction-mode PgBouncer (pooled) | `DATABASE_URL` | Application queries, serverless |
| `:5432` | Direct Postgres connection | `DATABASE_DIRECT_URL` | Migrations, DDL, admin scripts |

Transaction-mode pooling means **each transaction** - not each session - is
assigned to whichever backend connection is free. Two things follow:

1. **Server-side prepared statements break.** A statement prepared on one
   backend does not exist on the next one your session lands on, causing
   intermittent `prepared statement "..." does not exist` errors under load.
   postgres-js must run with `prepare: false` against `:6432`.
2. **Session state doesn't stick.** Advisory locks, `SET`, and long
   multi-statement transactions - exactly what migration tools rely on - are
   not safe through the pooler. **DDL and migrations must use the direct URL.**

`createDb()` detects `:6432` (or `pooled: true`) and defaults the client to
`{ prepare: false, max: 1 }`; direct URLs default to `{ max: 10 }`. Your own
`client` options override any default:

```ts
const db = createDb({ client: { max: 2, idle_timeout: 20 } })
```

Connection strings from CapyDB already include `sslmode=require`; postgres-js
picks TLS up from the URL, so nothing extra is needed.

## Serverless guidance

In serverless runtimes (Vercel, Lambda, Workers with TCP), every
concurrently-warm function instance holds its own connection pool. Keep each
one tiny - the default `max: 1` (or at most `2`) is deliberate. The pooler's
whole job is to multiplex many small client pools onto a few real backend
connections; a large per-instance `max` just exhausts pooler slots. Create the
client once at module scope so warm invocations reuse it:

```ts
// db.ts - module scope, reused across invocations
import { createDb } from '@capydb/drizzle'

export const db = createDb()
```

On hot paths, `createDb({ jit: true })` opts into drizzle v1's JIT-compiled
result mappers (mapping compiled once per query shape).

## Migrations

Use `createDirectDb()` (resolution order: `options.connectionString`,
`CAPYDB_DATABASE_DIRECT_URL`, `DATABASE_DIRECT_URL`) for programmatic
migrations. It rejects a pooled `:6432` URL (or `pooled: true`) before opening
a client, because client flags cannot make transaction-pooled DDL safe:

```ts
// scripts/migrate.ts
import { createDirectDb } from '@capydb/drizzle'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

const db = createDirectDb()
await migrate(db, { migrationsFolder: './drizzle' })
await db.$client.end()
```

And point drizzle-kit at the **direct** URL:

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // drizzle-kit v1 manages ALL schemas by default; scope push/pull to yours
  // so extension-created schemas (e.g. cron from pg_cron) are never touched.
  schemaFilter: ['public'],
  dbCredentials: {
    // Never the pooled DATABASE_URL: transaction pooling breaks the advisory
    // locks and session state migration tooling depends on.
    url: process.env.DATABASE_DIRECT_URL!,
  },
})
```

## Scale-to-zero: pauses and warm-ups

A cell on scale-to-zero pauses after a quiet spell and resumes on the next
connection. A *new* connection to a paused cell is held while it resumes, so
it only sees a slower connect. What needs handling is a connection that was
already open when the cell paused - a long-lived server between requests, or a
serverless instance frozen between invocations:

- the statement in flight fails with `CONNECTION_CLOSED`,
- the next statement on that connection receives the server's `57P01`
  (`terminating connection due to administrator command`),
- the one after that reconnects cleanly - postgres-js replaces the dead
  connection itself.

CapyDB does not pause a cell while a statement or transaction is open on it,
so in practice this hits idle connections, and the failing statement is the
first one after the pause.

`retryOnPause` absorbs exactly those failures and rethrows everything else
untouched. Wrap work that is safe to run twice - a read, or a whole
transaction (one cut off by the pause was rolled back by the server):

```ts
import { retryOnPause, withAuthContext } from '@capydb/drizzle'

const rows = await retryOnPause(() => db.select().from(users))

const todos = await retryOnPause(() =>
  withAuthContext(db, { userId }, (tx) => tx.select().from(schema.todos)),
)
```

Wrap the whole `db.transaction(...)` call, never a statement inside it - the
transaction's connection is gone, so an inner retry can only fail again. Do
not wrap a single write outside a transaction: if the connection closed after
the server committed, the retry would apply it twice. Nothing in this package
retries implicitly, because only you know which work is idempotent.

The default budget is 3 attempts (100 ms backoff, doubling, at most 2 s) -
the minimum that covers both failures. When it runs out, `retryOnPause`
throws `CellPausedError`, with the last pause error as its `cause`. Tune it
with `{ attempts, baseDelayMs, maxDelayMs, signal }`.

**Cron jobs, CI steps and migrations** that are the first thing to touch a
paused cell can warm it up explicitly with `waitForWake`, which retries a
`select 1` (10 attempts, 250 ms doubling to at most 5 s - about 30 s in total)
and throws `CellPausedError` if the cell never answers:

```ts
// scripts/migrate.ts - or the first step of a scheduled job
import { createDirectDb, waitForWake } from '@capydb/drizzle'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

const db = createDirectDb()
await waitForWake(db.$client, { signal: AbortSignal.timeout(60_000) })
await migrate(db, { migrationsFolder: './drizzle' })
await db.$client.end()
```

A cron handler that runs every few minutes keeps the cell awake as a side
effect; that is a property of the schedule, not something to rely on. For a
cell that must never pause, turn scale-to-zero off for the project with
`capydb projects always-on on`.

`isCellWakingError(error)` - the classifier both helpers use - is exported for
building your own policy. It follows `cause` chains, so it sees through
drizzle's query-error wrapper.

## Row-level security context

If your database uses RLS with the vanilla GUC convention (what
`capydb migrate rls` emits when converting Supabase policies), set the
per-request context with `withAuthContext` - it opens a transaction, applies
the context transaction-locally, and runs your callback inside it:

```ts
import { withAuthContext } from '@capydb/drizzle'

const todos = await withAuthContext(db, { userId: session.userId }, (tx) =>
  tx.select().from(schema.todos)
)
```

Why a transaction: `set_config(..., true)` is `SET LOCAL` semantics, which is
the only pooler-safe shape - on the `:6432` endpoint, transaction-mode
PgBouncer may run each statement of a session on a different backend, so a
session-level `SET` would leak one user's identity into another request's
connection. Always query through the `tx` handle inside the callback; `db`
queries run outside the context.

Promoted JWT claims and the claims blob ride along the same way:

```ts
await withAuthContext(
  db,
  { userId, set: { 'app.org_id': orgId }, claims: rawJwtClaims },
  (tx) => tx.select().from(schema.documents)
)
```

For databases converted with `--mode supabase-compat`, use
`withSupabaseJwtClaims(db, claims, callback)` - it sets the whole (verified!)
claims object as `request.jwt.claims` for the `auth.uid()` shim to read.

## Bulk ingest and error handling

Scripts that load or rewrite a lot of data run on the direct endpoint with a
small, named, bounded pool, and retry only what a retry can fix:

```ts
import { batchClientOptions, createDirectDb, formatQueryError, isTransientQueryError } from '@capydb/drizzle'

const db = createDirectDb({
  client: batchClientOptions({ applicationName: 'ingest', statementTimeoutMs: 300_000 }),
})

for (let attempt = 1; ; attempt++) {
  try {
    await runStep(db)
    break
  } catch (error) {
    // Connection drops, a pausing/resuming cell, serialization and deadlock
    // rollbacks and "too many connections" are worth another go.
    if (isTransientQueryError(error) && attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt))
      continue
    }
    // Everything else fails the same way next time - say why and stop.
    console.error(formatQueryError(error))
    // 22008 data_exception: date/time field value out of range: "1992-10-00"
    //   (parameter $2256 = '1992-10-00'; not retryable) — query: update "games" g set …
    throw error
  }
}

await db.$client.end()
```

The rule: **retry only connection-class errors; data (22), constraint (23) and
syntax (42) errors fail the same way on every attempt - fix the input, do not
retry.** Drizzle's `DrizzleQueryError` says `Failed query: <sql>` and keeps the
real reason on `.cause`; `describeQueryError(error)` returns it structured
(`sqlstate`, `class`, `retryable`, `message`, `detail`, `hint`, `where`, the
first 200 characters of the SQL, and the parameter Postgres named, resolved to
its value) and `formatQueryError(error)` prints it on one line.

Why the pool is small: the driver's default of 10 connections is sized for an
application server. Three ingest processes side by side each opened 10 and used
41 of a 60-connection plan; `batchClientOptions` keeps three (override with
`max`), names the sessions so the dashboard can tell them from the app's, and
bounds one runaway statement with `statement_timeout` when you ask for it.
Long UPDATEs still belong in chunks (an 813-second one opened a
`long_transaction` alert) - the timeout is a backstop, not a strategy.

## Calling Postgres functions

`callFunction` is the drizzle equivalent of `supabase.rpc(name, args)`: it
calls a function with named arguments and returns the rows it produces.

```ts
import { callFunction, withAuthContext } from '@capydb/drizzle'

const feed = await withAuthContext(db, { userId }, (tx) =>
  callFunction<{ id: string; title: string }>(tx, 'get_feed', {
    p_limit: 20,
    p_filters: { tags: ['postgres'] }, // jsonb parameter
  }),
)
```

The statement is `select * from get_feed(p_limit => $1, p_filters => $2)`:
named notation, as PostgREST used, so existing functions keep their parameter
names and argument order does not matter. Names are quoted as identifiers and
values are bound parameters.

- `undefined` leaves the argument out, so the parameter's `DEFAULT` applies; a
  parameter without a default then fails loudly (`function ... does not
  exist`). Pass `null` for SQL NULL.
- Plain objects are JSON-encoded for `json`/`jsonb` parameters. Arrays go as
  Postgres arrays - for a JSON array argument, pass `JSON.stringify(value)`.
- A table or set-returning function yields its rows; a scalar function yields
  one row with one column named after the function
  (`[{ add: 42 }]` for `add(a => 40, b => 2)`).
- `{ schema: 'api' }` qualifies the name; by default it resolves through the
  role's `search_path`.
- The row type is a claim about the function, not checked at runtime - the
  same contract as `supabase.rpc<T>()`.

Call it with the `tx` handle inside `withAuthContext`: a function called
through `db` runs outside the RLS context.

## API

- `createDb<TRelations>(options?)` - pooled-aware application client. Returns
  `PostgresJsDatabase<TRelations> & { $client: Sql }`.
- `createDirectDb<TRelations>(options?)` - direct-connection client for
  migrations/DDL. Same return type.
- `CapyDBDrizzleOptions<TRelations>` - `{ connectionString?, pooled?, client?, relations?, logger?, jit? }`.
  (drizzle v1 dropped the driver-level `schema`/`casing` options: tables are
  used directly in queries, `db.query.*` comes from `relations`, and casing is
  configured at table level with drizzle's casing helpers.)
- `withAuthContext(db, context, callback)` - runs the callback in a
  transaction with the RLS context applied transaction-locally
  (`app.user_id`, `app.role`, `app.email`, `app.claims`, plus custom GUCs via
  `set`). Pooler-safe by construction.
- `withSupabaseJwtClaims(db, claims, callback)` - same, but sets
  `request.jwt.claims` for databases using the supabase-compat shim.
- `callFunction<TRow>(db | tx, name, args?, { schema? }?)` - calls a Postgres
  function with named arguments and returns its rows.
- `AuthContext` / `AuthContextTransaction<TRelations>` - the context shape and
  the transaction handle type passed to the callbacks.
- `retryOnPause(operation, options?)` - re-runs idempotent work (a read or a
  whole transaction) when a pause cut it off. Throws `CellPausedError` once
  the attempt budget is spent.
- `waitForWake(client, options?)` - bounded warm-up for cron, CI and
  migrations; throws `CellPausedError` if the cell never answers.
- `isCellWakingError(error)` - whether an error is a pause/resume condition.
- `isTransientQueryError(error)` - whether an error is worth retrying unchanged:
  pause/resume, any connection error (SQLSTATE class 08), serialization and
  deadlock rollbacks, too many connections. Data, constraint and syntax errors
  are not.
- `describeQueryError(error)` - `QueryErrorDescription | undefined`: the
  SQLSTATE, its class name, `retryable`, the message with DETAIL/HINT/CONTEXT,
  the SQL drizzle ran (first 200 characters) and the offending parameter,
  read through `DrizzleQueryError.cause`.
- `formatQueryError(error)` - the same on one line, for catch blocks.
- `batchClientOptions({ applicationName, statementTimeoutMs?, max? })` -
  postgres-js options for a bulk/ingest session on the direct endpoint
  (`max` 3, `idle_timeout` 60, `application_name`, optional
  `statement_timeout`); pass as `client` to `createDirectDb`.
- `CellPausedError` - the typed error both helpers throw; `attempts` and the
  last pause error as `cause`.
- `resolveConnectionString(explicit, envVarNames, env?)`,
  `resolveClientOptions(connectionString, pooled, overrides?)`,
  `isPooledUrl(connectionString)` - the pure resolution helpers, exported for
  testing and tooling.

Everything else (query builders, `sql`, migrator, …) comes from `drizzle-orm`
directly - this package deliberately re-exports nothing from it.

## Development

```bash
pnpm install
pnpm build       # tsdown (ESM + CJS) + tsgo declarations
pnpm typecheck
pnpm lint        # oxlint
pnpm test        # vitest
```

`test/live.test.ts` runs against a real Postgres and is skipped unless
`CAPYDB_DRIZZLE_TEST_DATABASE_URL` is set (CI provides one):

```bash
docker run -d --rm --name drizzle-pg -e POSTGRES_PASSWORD=pw -p 55499:5432 postgres:18
CAPYDB_DRIZZLE_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55499/postgres pnpm test
```

## License

MIT
