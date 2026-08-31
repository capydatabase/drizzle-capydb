/**
 * @capydb/drizzle - Drizzle ORM helpers for CapyDB.
 *
 * A thin, typed convenience layer over `drizzle-orm/postgres-js` + `postgres`
 * (both peer dependencies) that encodes CapyDB's operational rules so you
 * don't have to remember them:
 *
 * - CapyDB cells expose two endpoints on `*.db.capydb.dev`: the pooled port
 *   `:6432` (transaction-mode PgBouncer) and the direct port `:5432`.
 * - Through the transaction pooler, server-side prepared statements are
 *   unsafe: the pooler may run each statement of a session on a different
 *   backend connection, so a statement prepared on one backend does not exist
 *   on the next. postgres-js must therefore run with `prepare: false`.
 * - In serverless environments every concurrently-warm function instance
 *   opens its own pool, so per-instance pools must stay tiny (`max: 1`).
 *   The pooler multiplexes those many small pools onto few real backends.
 * - DDL and migrations must use the DIRECT url: transaction pooling breaks
 *   session-level state (advisory locks, `SET`, multi-statement migration
 *   transactions) that migration tools rely on.
 *
 * CapyDB connection strings carry `sslmode=verify-full` - the data plane is
 * served from a publicly trusted wildcard certificate, so clients verify the
 * chain AND the hostname rather than merely encrypting. postgres-js honours
 * `sslmode` from the URL against Node's system trust store, so no extra TLS
 * configuration is needed here. libpq-only TLS parameters (`sslrootcert` and
 * friends, which psql users add) are stripped before postgres-js can forward
 * them as startup parameters - see {@link stripLibpqTLSParams}.
 */
import { sql, type AnyRelations, type DrizzleConfig, type EmptyRelations } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Options, type PostgresType, type Sql } from "postgres";

/** postgres-js client options as accepted by `postgres(url, options)`. */
type ClientOptions = Options<Record<string, PostgresType>>;

/** The transaction-mode PgBouncer port on CapyDB hosts (`:5432` is direct). */
const POOLED_PORT = "6432";

/**
 * Startup parameters PgBouncer tracks per client connection and replays on
 * whichever backend it borrows - safe to send to the pooled endpoint.
 */
const POOLER_TRACKED_STARTUP_PARAMS: ReadonlySet<string> = new Set([
  "client_encoding",
  "datestyle",
  "timezone",
  "standard_conforming_strings",
  "application_name",
]);

/**
 * Startup parameters the CapyDB pooler ACCEPTS BUT NEVER APPLIES
 * (`ignore_startup_parameters` on the per-cell PgBouncer). The connection
 * succeeds, but the value is silently not in effect - the durable equivalent
 * is `ALTER ROLE your_role SET <param> = ...` on the direct endpoint.
 */
const POOLER_IGNORED_STARTUP_PARAMS: ReadonlySet<string> = new Set([
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  "lock_timeout",
  "idle_session_timeout",
  "extra_float_digits",
  "options",
  // Client-side libpq TLS options. The pooler ignores them so that a URL
  // carrying psql's sslrootcert=system cannot take every pooled connection
  // down with 08P01. KEEP IN LOCKSTEP with ignore_startup_parameters in
  // capydb-pool-sync.sh.j2.
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslcrl",
  "sslcompression",
]);

/** Env vars checked (in order) by {@link createDb} after `options.connectionString`. */
const POOLED_ENV_VARS = ["CAPYDB_DATABASE_URL", "DATABASE_URL"] as const;

/** Env vars checked (in order) by {@link createDirectDb} after `options.connectionString`. */
const DIRECT_ENV_VARS = ["CAPYDB_DATABASE_DIRECT_URL", "DATABASE_DIRECT_URL"] as const;

/**
 * Options for {@link createDb} and {@link createDirectDb}.
 *
 * `relations` and `logger` are forwarded verbatim to drizzle; everything else
 * controls how the underlying postgres-js client is built.
 *
 * Note (drizzle-orm v1): the driver config no longer takes a `schema` map -
 * table objects from your schema file are used directly in queries, and the
 * relational query API (`db.query.*`) is enabled by passing the result of
 * `defineRelations` as `relations`.
 */
export interface CapyDBDrizzleOptions<TRelations extends AnyRelations = EmptyRelations> {
  /**
   * Explicit connection string. When set, environment variables are not
   * consulted at all. Useful for scripts and tests.
   */
  connectionString?: string;
  /**
   * Force pooled (`true`) or direct (`false`) client defaults instead of
   * inferring them from the URL's port. You normally never need this: URLs
   * targeting `:6432` are detected automatically. Set `pooled: true` when a
   * transaction pooler sits in front of the database on a non-standard port
   * (the pooler rules still apply even if the port doesn't say so).
   */
  pooled?: boolean;
  /**
   * postgres-js options merged OVER the CapyDB defaults via spread, so any
   * key you set here wins. Careful with `prepare: true` against the pooled
   * endpoint - transaction-mode PgBouncer will hand your session's statements
   * to different backends and prepared statements will randomly not exist.
   */
  client?: ClientOptions;
  /**
   * Relations built with drizzle's `defineRelations`, enabling the relational
   * query API (`db.query.*`). Optional - plain `db.select().from(table)`
   * queries need nothing here.
   */
  relations?: TRelations;
  /** Drizzle logger (or `true` for the default logger), forwarded as-is. */
  logger?: DrizzleConfig["logger"];
  /**
   * Opt into drizzle v1's JIT-compiled result mappers. Worth enabling for
   * hot paths: mapping is compiled once per query shape instead of
   * interpreted per row. Forwarded as-is.
   */
  jit?: DrizzleConfig["jit"];
}

/**
 * Resolve a connection string from an explicit value or a prioritized list of
 * environment variables.
 *
 * Exported for testability and for tools that want the same resolution
 * semantics without constructing a client.
 *
 * @param explicit - `options.connectionString`; wins outright when non-empty.
 * @param envVarNames - environment variable names checked in order; the first
 *   non-empty value wins.
 * @param env - environment map, defaults to `process.env` (injectable for tests).
 * @throws Error naming every checked source when nothing is set, so a
 *   misconfigured deploy fails loudly at startup instead of at first query.
 */
export function resolveConnectionString(
  explicit: string | undefined,
  envVarNames: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string {
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  for (const name of envVarNames) {
    const value = env[name];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  throw new Error(
    `@capydb/drizzle: no connection string found. Pass \`connectionString\` in options ` +
      `or set one of these environment variables: ${envVarNames.join(", ")}. ` +
      `Run \`capydb env pull\` to populate them from your linked project.`,
  );
}

/**
 * Whether a connection string targets CapyDB's transaction-mode pooler.
 *
 * Detection is by port: `:6432` is the per-cell PgBouncer (transaction
 * pooling), `:5432` is the direct postmaster. Falls back to a conservative
 * regex when the string is not WHATWG-URL-parseable.
 */
export function isPooledUrl(connectionString: string): boolean {
  // Only trust WHATWG URL parsing when there is a real scheme separator:
  // bare "host:6432" would otherwise parse as scheme "host" + path "6432"
  // and report no port at all.
  if (connectionString.includes("://")) {
    try {
      return new URL(connectionString).port === POOLED_PORT;
    } catch {
      // Not URL-parseable after all - fall through to the regex.
    }
  }
  return /:6432(?=[/?]|$)/.test(connectionString);
}

/**
 * Compute the postgres-js options for a connection string.
 *
 * Pooled defaults (`:6432` or `pooled: true`) are `{ prepare: false, max: 1 }`:
 *
 * - `prepare: false` because transaction-mode PgBouncer routes each
 *   transaction to whichever backend is free - a statement prepared on one
 *   backend simply does not exist on the next, producing intermittent
 *   `prepared statement "..." does not exist` errors under load.
 * - `max: 1` because in serverless runtimes every warm instance holds its own
 *   pool; the pooler's job is to multiplex many tiny client pools onto a few
 *   real backend connections, so a big per-instance pool only burns pooler
 *   slots.
 *
 * Direct defaults are `{ max: 10 }` - a long-lived server process talking to
 * the postmaster can safely hold a modest pool and use prepared statements.
 *
 * Caller `overrides` are spread last and win key-by-key.
 *
 * @param connectionString - used for port-based pooled detection.
 * @param pooled - explicit override; `undefined` means "infer from the URL".
 * @param overrides - caller-provided postgres-js options.
 */
export function resolveClientOptions(
  connectionString: string,
  pooled: boolean | undefined,
  overrides?: ClientOptions,
): ClientOptions {
  const usePooledDefaults = pooled ?? isPooledUrl(connectionString);
  if (usePooledDefaults && overrides?.connection) {
    assertPooledStartupParameters(overrides.connection);
  }
  const defaults: ClientOptions = usePooledDefaults ? { prepare: false, max: 1 } : { max: 10 };
  return { ...defaults, ...overrides };
}

/**
 * Validate postgres-js `connection: {...}` options against the pooled
 * endpoint's startup-parameter rules.
 *
 * postgres-js sends every `connection` key as a wire-level startup parameter
 * on each new connection. Behind transaction-mode PgBouncer three things can
 * happen, and two of them deserve to be loud:
 *
 * - Tracked params (`application_name`, `client_encoding`, ...) are replayed
 *   per client - fine, silently allowed.
 * - Ignored params (`statement_timeout` and friends) connect successfully but
 *   are NEVER APPLIED - a `console.warn` names each one and the durable fix
 *   (`ALTER ROLE ... SET`), because a timeout you believe is set and isn't is
 *   a production incident waiting for a slow query.
 * - Anything else (e.g. `search_path`) is rejected by the pooler at handshake
 *   with `unsupported startup parameter` (08P01), taking every connection
 *   down with it - this throws at client construction instead, with the same
 *   remediation, so a misconfigured deploy dies loudly at startup rather than
 *   at first query.
 *
 * @param connection - the `connection` object passed in `options.client`.
 * @throws Error naming every parameter the pooler would reject at handshake.
 */
export function assertPooledStartupParameters(connection: Record<string, unknown>): void {
  const ignored: string[] = [];
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(connection)) {
    if (value === undefined || value === null) continue;
    const name = key.toLowerCase();
    if (POOLER_TRACKED_STARTUP_PARAMS.has(name)) continue;
    (POOLER_IGNORED_STARTUP_PARAMS.has(name) ? ignored : rejected).push(key);
  }
  if (rejected.length > 0) {
    throw new Error(
      `@capydb/drizzle: connection option(s) ${rejected.join(", ")} would be sent as ` +
        `startup parameters, which CapyDB's pooled (:6432) endpoint rejects at handshake ` +
        `("unsupported startup parameter", 08P01) - every connection would fail. Set them ` +
        `durably instead (ALTER ROLE your_role SET <param> = ... on the direct endpoint), ` +
        `or use createDirectDb for a client that needs them per-connection.`,
    );
  }
  if (ignored.length > 0) {
    console.warn(
      `@capydb/drizzle: connection option(s) ${ignored.join(", ")} are accepted by ` +
        `CapyDB's pooled (:6432) endpoint but NOT applied - the value is silently ` +
        `ignored under transaction pooling. Set them durably with ` +
        `ALTER ROLE your_role SET <param> = ... (applies to pooled and direct connections), ` +
        `then remove them from the client options.`,
    );
  }
}

/** Shared implementation for {@link createDb} and {@link createDirectDb}. */
function createFromSources<TRelations extends AnyRelations>(
  options: CapyDBDrizzleOptions<TRelations>,
  envVarNames: readonly string[],
  requireDirect = false,
): PostgresJsDatabase<TRelations> & { $client: Sql } {
  const connectionString = resolveConnectionString(options.connectionString, envVarNames);
  if (requireDirect && (options.pooled === true || isPooledUrl(connectionString))) {
    throw new Error(
      "@capydb/drizzle: createDirectDb requires a direct Postgres connection, but the " +
        "resolved URL targets the pooled endpoint. Set CAPYDB_DATABASE_DIRECT_URL or " +
        "DATABASE_DIRECT_URL to the :5432 connection before running migrations or DDL.",
    );
  }
  const sanitized = stripLibpqTLSParams(connectionString);
  const client = postgres(
    sanitized,
    resolveClientOptions(sanitized, options.pooled, options.client),
  );
  return drizzle<TRelations>({
    client,
    relations: options.relations,
    logger: options.logger,
    jit: options.jit,
  });
}

/**
 * Create a Drizzle database backed by a postgres-js client with CapyDB-safe
 * defaults. This is the client your application code should use.
 *
 * Connection string resolution order:
 * 1. `options.connectionString`
 * 2. `CAPYDB_DATABASE_URL`
 * 3. `DATABASE_URL`
 *
 * (`capydb env pull` writes `DATABASE_URL` pointing at the pooled `:6432`
 * endpoint; some setups also expose `CAPYDB_DATABASE_URL`.)
 *
 * When the resolved URL targets the pooled port - or `options.pooled` is
 * `true` - the client defaults to `{ prepare: false, max: 1 }`. Both are
 * load-bearing behind transaction-mode PgBouncer: prepared statements break
 * because consecutive statements may execute on different backends, and tiny
 * per-instance pools are what let many serverless instances share few real
 * connections. Direct URLs default to `{ max: 10 }`. Anything in
 * `options.client` overrides these defaults.
 *
 * Do NOT run migrations/DDL through this client when it points at the pooled
 * endpoint - use {@link createDirectDb} (or `DATABASE_DIRECT_URL` in your
 * drizzle-kit config) instead.
 *
 * @example
 * ```ts
 * import { createDb } from '@capydb/drizzle'
 * import { users } from './db/schema' // e.g. from `capydb generate drizzle`
 *
 * export const db = createDb()
 * const rows = await db.select().from(users)
 * ```
 *
 * For the relational query API, pass relations:
 * ```ts
 * import { defineRelations } from 'drizzle-orm'
 * import * as schema from './db/schema'
 *
 * const relations = defineRelations(schema, (r) => ({ ... }))
 * export const db = createDb({ relations })
 * ```
 */
export function createDb<TRelations extends AnyRelations = EmptyRelations>(
  options: CapyDBDrizzleOptions<TRelations> = {},
): PostgresJsDatabase<TRelations> & { $client: Sql } {
  return createFromSources(options, POOLED_ENV_VARS);
}

/**
 * Create a Drizzle database on the DIRECT (`:5432`) endpoint, for
 * migrations, DDL, and one-off admin scripts.
 *
 * Connection string resolution order:
 * 1. `options.connectionString`
 * 2. `CAPYDB_DATABASE_DIRECT_URL`
 * 3. `DATABASE_DIRECT_URL`
 *
 * Why a separate entry point: transaction-mode PgBouncer (the pooled `:6432`
 * endpoint) breaks the session-level machinery migration tools depend on -
 * advisory locks used to serialize concurrent migrators, `SET`/`SET LOCAL`,
 * and long multi-statement transactions. DDL must therefore always go over a
 * direct connection; this function makes the safe path the easy path.
 *
 * Defaults to direct-connection settings (`{ max: 10 }`, prepared statements
 * enabled). If the resolved URL points at `:6432` (or `pooled: true` is set),
 * this function throws before constructing a client: changing postgres-js
 * options cannot make transaction-pooled migrations safe.
 *
 * @example
 * ```ts
 * // scripts/migrate.ts
 * import { createDirectDb } from '@capydb/drizzle'
 * import { migrate } from 'drizzle-orm/postgres-js/migrator'
 *
 * const db = createDirectDb()
 * await migrate(db, { migrationsFolder: './drizzle' })
 * await db.$client.end()
 * ```
 */
export function createDirectDb<TRelations extends AnyRelations = EmptyRelations>(
  options: CapyDBDrizzleOptions<TRelations> = {},
): PostgresJsDatabase<TRelations> & { $client: Sql } {
  return createFromSources(options, DIRECT_ENV_VARS, true);
}

/**
 * Error codes and socket errnos that mean "this cell is paused, resuming, or
 * was just paused underneath us" rather than "your query is wrong".
 *
 * Scale-to-zero makes these normal rather than exceptional: the idle sweep can
 * pause a cell between two requests, so a connection that was healthy a minute
 * ago is gone. Note that a *new* connection to a paused cell does NOT land
 * here - the routing layer holds it, drives a single-flight wake, and relays
 * once the cell is up, so the client only observes a slower connect.
 */
const WAKE_TRANSIENT_CODES = new Set([
  "57P01", // admin_shutdown - the cell was paused mid-session
  "57P03", // cannot_connect_now - still resuming
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08000", // connection_exception
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "CONNECT_TIMEOUT",
]);

/**
 * Report whether an error is a transient pause/resume condition that is worth
 * retrying, as opposed to a real failure.
 *
 * Exported so callers can build their own retry policy: this package
 * deliberately does not wrap query execution, because retrying an arbitrary
 * statement is only safe when the caller knows it is idempotent.
 *
 * @example
 * ```ts
 * try { await db.select().from(users) }
 * catch (error) {
 *   if (isCellWakingError(error)) { /* safe to retry a read *\/ }
 *   throw error
 * }
 * ```
 */
export function isCellWakingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && WAKE_TRANSIENT_CODES.has(code)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error ? isCellWakingError(cause) : false;
}

/** Options for {@link waitForWake}. */
export interface WaitForWakeOptions {
  /** Maximum attempts before giving up. Default 10. */
  attempts?: number;
  /** Initial backoff in milliseconds; doubles per attempt. Default 250. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff interval. Default 5000. */
  maxDelayMs?: number;
  /** Abort the wait early (e.g. a CI job timeout). */
  signal?: AbortSignal;
}

/**
 * Block until the cell answers a trivial query, retrying transient
 * pause/resume errors with exponential backoff.
 *
 * When you need this: batch jobs, cron, CI steps and migrations that are the
 * FIRST thing to touch a cell that has been paused. The routing layer already
 * holds and wakes a normal connection, so application traffic does not need
 * this - it is for callers that want a bounded, explicit warm-up before doing
 * something expensive, instead of discovering the cell was cold halfway
 * through a migration.
 *
 * Non-transient errors (bad credentials, a real SQL error) are rethrown
 * immediately rather than retried.
 *
 * @example
 * ```ts
 * const db = createDirectDb()
 * await waitForWake(db.$client)          // bounded warm-up
 * await migrate(db, { migrationsFolder: './drizzle' })
 * ```
 */
export async function waitForWake(client: Sql, options: WaitForWakeOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 10;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5000;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    options.signal?.throwIfAborted();
    try {
      await client`select 1`;
      return;
    } catch (error) {
      if (!isCellWakingError(error)) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error(
    `cell did not become ready after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * libpq connection parameters that configure TLS on the CLIENT and have no
 * meaning to a Postgres server.
 *
 * libpq consumes these locally and never puts them on the wire. postgres-js
 * does not recognise them, and its rule for unrecognised URL query parameters
 * is to forward them as wire startup parameters - so a connection string
 * copied out of a psql invocation (`...?sslmode=verify-full&sslrootcert=system`)
 * turns into a startup packet the server never asked for. On the pooled
 * endpoint that is an 08P01 handshake rejection; on the direct endpoint
 * Postgres itself fails the connection with `unrecognized configuration
 * parameter`. Either way every connection dies, which is exactly the failure
 * shape of the 2026-07-22 pooler incident.
 *
 * `sslmode` is deliberately NOT in this list: postgres-js understands it and
 * maps it onto its own TLS behaviour, so it must survive.
 */
const LIBPQ_CLIENT_TLS_PARAMS: ReadonlySet<string> = new Set([
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslcrl",
  "sslcompression",
  "sslsni",
  "channel_binding",
]);

/**
 * Remove libpq-only TLS parameters from a connection string.
 *
 * This is connection policy, not query behaviour: it makes one connection
 * string usable by psql and by postgres-js, which is the whole point of
 * handing users a single URL. Anything postgres-js genuinely understands
 * (including `sslmode`) is preserved untouched.
 *
 * Exported for tools that need the same normalisation without building a client.
 */
export function stripLibpqTLSParams(connectionString: string): string {
  if (!connectionString.includes("?")) return connectionString;
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    // Not URL-parseable (some libpq keyword/value forms are not); leave it be
    // rather than risk corrupting a string we do not fully understand.
    return connectionString;
  }
  // Snapshot the names first: deleting from a live URLSearchParams while
  // iterating it skips entries, so collecting the matches before mutating is
  // load-bearing, not stylistic.
  const doomed: string[] = [];
  parsed.searchParams.forEach((_value, key) => {
    if (LIBPQ_CLIENT_TLS_PARAMS.has(key.toLowerCase())) doomed.push(key);
  });
  for (const key of doomed) parsed.searchParams.delete(key);
  const changed = doomed.length > 0;
  return changed ? parsed.toString() : connectionString;
}

/**
 * Session context for row-level security, set as transaction-local GUCs.
 *
 * This is the application half of the vanilla RLS convention that
 * `capydb migrate rls` (and the standalone capyrls converter) emits: policies
 * read `app.user_id` / `app.role` / promoted claims through small accessor
 * functions, and the application states those facts per transaction. Unset
 * values read as NULL inside policies, so leaving a field out fails closed.
 */
export interface AuthContext {
  /** Sets `app.user_id` - what `auth.uid()` used to return on Supabase. */
  userId?: string;
  /** Sets `app.role`. `"service"` activates the converter's service escape. */
  role?: string;
  /** Sets `app.email`. */
  email?: string;
  /**
   * Sets `app.claims` (serialized to JSON) for policies that read deep claim
   * paths the converter could not promote to dedicated GUCs.
   */
  claims?: Record<string, unknown>;
  /**
   * Additional GUCs for promoted claims, e.g. `{ "app.org_id": orgId }`.
   * Names must be dotted (`namespace.key`); Postgres reserves undotted names.
   */
  set?: Record<string, string>;
}

type TransactionCallback<TRelations extends AnyRelations> = Parameters<
  PostgresJsDatabase<TRelations>["transaction"]
>[0];

/** The drizzle transaction handle passed to {@link withAuthContext}'s callback. */
export type AuthContextTransaction<TRelations extends AnyRelations = EmptyRelations> = Parameters<
  TransactionCallback<TRelations>
>[0];

/** Custom GUCs need a dotted name; Postgres rejects undotted custom settings. */
const CUSTOM_GUC_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

function authContextSettings(context: AuthContext): Array<[string, string]> {
  const settings: Array<[string, string]> = [];
  if (context.userId !== undefined) settings.push(["app.user_id", context.userId]);
  if (context.role !== undefined) settings.push(["app.role", context.role]);
  if (context.email !== undefined) settings.push(["app.email", context.email]);
  if (context.claims !== undefined) settings.push(["app.claims", JSON.stringify(context.claims)]);
  if (context.set) {
    for (const [name, value] of Object.entries(context.set)) {
      if (!CUSTOM_GUC_NAME.test(name)) {
        throw new Error(
          `@capydb/drizzle: invalid GUC name ${JSON.stringify(name)} in AuthContext.set - ` +
            `custom settings need a dotted name like "app.org_id"`,
        );
      }
      settings.push([name, value]);
    }
  }
  return settings;
}

async function runWithTransactionLocalSettings<TRelations extends AnyRelations, T>(
  db: Pick<PostgresJsDatabase<TRelations>, "transaction">,
  settings: Array<[string, string]>,
  callback: (tx: AuthContextTransaction<TRelations>) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (settings.length > 0) {
      const assignments = settings.map(([name, value]) => sql`set_config(${name}, ${value}, true)`);
      await tx.execute(sql`select ${sql.join(assignments, sql`, `)}`);
    }
    return callback(tx);
  });
}

/**
 * Run queries under a row-level-security context, pooler-safely.
 *
 * Opens a transaction, applies the context with `set_config(..., true)` -
 * transaction-local, i.e. `SET LOCAL` semantics - and runs the callback
 * inside that same transaction. This shape is load-bearing on CapyDB's
 * pooled endpoint (`:6432`): transaction-mode PgBouncer may hand each
 * statement of a session to a different backend, so a session-level `SET`
 * would leak your user's identity into some OTHER request's connection.
 * Transaction-local settings cannot outlive the transaction, on any backend.
 *
 * Queries made with `db` (not `tx`) inside the callback run OUTSIDE the
 * context - always use the transaction handle you are given.
 *
 * @example
 * const todos = await withAuthContext(db, { userId: session.userId }, (tx) =>
 *   tx.select().from(schema.todos)
 * )
 *
 * @throws When a custom GUC name in `context.set` is not dotted.
 */
export async function withAuthContext<TRelations extends AnyRelations, T>(
  db: Pick<PostgresJsDatabase<TRelations>, "transaction">,
  context: AuthContext,
  callback: (tx: AuthContextTransaction<TRelations>) => Promise<T>,
): Promise<T> {
  return runWithTransactionLocalSettings(db, authContextSettings(context), callback);
}

/**
 * Like {@link withAuthContext}, but for databases converted with
 * `capydb migrate rls --mode supabase-compat`: sets the whole claims object
 * as `request.jwt.claims`, which the compat `auth.uid()`/`auth.jwt()` shim
 * reads. Include at least `sub` (and `role` where policies check it).
 *
 * The claims are trusted as given - verify the JWT before calling this;
 * nothing inside the database checks signatures anymore.
 */
export async function withSupabaseJwtClaims<TRelations extends AnyRelations, T>(
  db: Pick<PostgresJsDatabase<TRelations>, "transaction">,
  claims: Record<string, unknown>,
  callback: (tx: AuthContextTransaction<TRelations>) => Promise<T>,
): Promise<T> {
  return runWithTransactionLocalSettings(
    db,
    [["request.jwt.claims", JSON.stringify(claims)]],
    callback,
  );
}
