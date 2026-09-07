# Changelog

All notable changes to `@capydb/drizzle` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.3] - 2026-09-07

### Fixed
- Repository URLs in the package metadata and changelog now point to the `capydatabase` organization, so links from the npm listing resolve correctly ([82692b3](https://github.com/capy-base/drizzle-capydb/commit/82692b3))

## [1.6.1] - 2026-09-02

### Dependencies

- **deps:** bump @types/node, oxfmt, and oxlint ([9eef9ed](https://github.com/capydatabase/drizzle-capydb/commit/9eef9ed))

### Miscellaneous Chores

- bump dev tooling (@types/node, lefthook) ([2a7fff0](https://github.com/capydatabase/drizzle-capydb/commit/2a7fff0))
- update pnpm to version 12.0.0 in package.json and pnpm-lock.yaml ([bb64a3b](https://github.com/capydatabase/drizzle-capydb/commit/bb64a3b))
- update pnpm workspace configuration and improve TypeScript settings ([8290373](https://github.com/capydatabase/drizzle-capydb/commit/8290373))

## [1.6.0] - 2026-08-18

### Added

- `createDb` and `createDirectDb` factories for pooled and direct CapyDB connections, with pooler-safe defaults (`prepare: false` on the pooled `:6432` endpoint), plus connection string resolution from environment variables or explicit options via `resolveConnectionString`, `isPooledUrl`, and `resolveClientOptions` ([01d230d](https://github.com/capydatabase/drizzle-capydb/commit/01d230d))
- Startup parameter validation for pooled connections: `assertPooledStartupParameters` checks postgres-js `connection` options against the pooled endpoint's rules — tracked parameters pass through, ignored ones warn, and unsupported ones (e.g. `search_path`) throw at startup instead of failing on every connection; `resolveClientOptions` runs this check automatically when targeting a pooled connection ([8b0014e](https://github.com/capydatabase/drizzle-capydb/commit/8b0014e))
- `waitForWake` and `isCellWakingError` for handling scale-to-zero: detect transient pause/resume errors and block with exponential backoff until the database cell is ready ([9cde845](https://github.com/capydatabase/drizzle-capydb/commit/9cde845))
- `stripLibpqTLSParams` to remove libpq-only TLS query parameters (e.g. `sslrootcert`, `sslcert`) from connection strings that postgres-js would otherwise forward as unsupported wire parameters ([9cde845](https://github.com/capydatabase/drizzle-capydb/commit/9cde845))
- Row-level security context helpers: `withAuthContext` runs queries in a transaction with transaction-local `app.user_id`/`app.role`/`app.email`/`app.claims` settings (plus custom GUCs), and `withSupabaseJwtClaims` sets verified claims as `request.jwt.claims` for Supabase-compat databases; includes the `AuthContext` interface and `AuthContextTransaction` type ([5dfced0](https://github.com/capydatabase/drizzle-capydb/commit/5dfced0))
### Changed

- `createDirectDb` now rejects pooled connection strings, enforcing a direct connection for migrations ([1aab8e9](https://github.com/capydatabase/drizzle-capydb/commit/1aab8e9))
- Connection string handling sanitizes libpq-only TLS parameters automatically for postgres-js compatibility ([9cde845](https://github.com/capydatabase/drizzle-capydb/commit/9cde845))

## [1.4.0] - 2026-08-03

### Added

- `withAuthContext(db, context, callback)` - runs queries under a row-level-security context: opens a transaction, applies `app.user_id`/`app.role`/`app.email`/`app.claims` (plus custom GUCs via `set`) with `set_config(..., true)`, and hands the callback the transaction. Transaction-local is the only pooler-safe shape - a session-level `SET` through transaction-mode PgBouncer would leak one user's identity into another request's connection.
- `withSupabaseJwtClaims(db, claims, callback)` - the same, for databases converted with `capydb migrate rls --mode supabase-compat`: sets the verified claims object as `request.jwt.claims` for the `auth.*` shim.
- `AuthContext` interface and `AuthContextTransaction<TRelations>` type.

## [1.2.0] - 2026-07-28

### Added

- `waitForWake(client, options?)` - blocks until the database cell is ready, retrying transient pause/resume errors with exponential backoff.
- `isCellWakingError(error)` - identifies transient cell wake (pause/resume) errors that are safe to retry.
- `stripLibpqTLSParams(connectionString)` - strips libpq-only TLS query parameters (e.g. `sslrootcert`, `sslcert`) that postgres-js would otherwise forward as wire startup parameters, keeping only parameters postgres-js understands.
- `WaitForWakeOptions` interface for configuring `waitForWake` retry behavior.

### Changed

- Connection string handling now sanitizes libpq-only TLS parameters automatically, ensuring compatibility with postgres-js.

## [1.1.0] - 2026-07-22

### Added

- `assertPooledStartupParameters(connection)` - validates postgres-js `connection` options against the pooled (:6432) endpoint's startup-parameter rules: tracked parameters pass through, ignored parameters (`statement_timeout` and friends) emit a warning because the pooler accepts-and-ignores them, and unsupported parameters (e.g. `search_path`) throw so a misconfigured deploy fails loudly at startup instead of with `unsupported startup parameter` (08P01) on every connection.
- `resolveClientOptions` now asserts startup parameters when targeting a pooled connection.

## [1.0.0] - 2026-07-17

### Added

- Initial release: `createDb`/`createDirectDb` factories with pooler-safe transaction-mode defaults (`prepare: false` on :6432), `resolveConnectionString`, `isPooledUrl`, and `resolveClientOptions`.
- `createDirectDb` enforces a direct (non-pooled) connection for migrations.

[1.6.3]: https://github.com/capy-base/drizzle-capydb/compare/v1.6.1...v1.6.3
[1.6.1]: https://github.com/capy-base/drizzle-capydb/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/capy-base/drizzle-capydb/compare/v1.4.0...v1.6.0
[1.4.0]: https://github.com/capy-base/drizzle-capydb/compare/v1.2.0...v1.4.0
[1.2.0]: https://github.com/capy-base/drizzle-capydb/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/capy-base/drizzle-capydb/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/capy-base/drizzle-capydb/releases/tag/v1.0.0
