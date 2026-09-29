/**
 * Tests against a real Postgres. Skipped unless CAPYDB_DRIZZLE_TEST_DATABASE_URL
 * is set; the URL's role must be allowed to create functions and tables and to
 * terminate its own sessions (a database owner can). Locally:
 *
 *   docker run -d --rm --name drizzle-pg -e POSTGRES_PASSWORD=pw -p 55499:5432 postgres:18
 *   CAPYDB_DRIZZLE_TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55499/postgres pnpm test
 *
 * The pause tests stand in for scale-to-zero with pg_terminate_backend: the
 * server's side of both is a backend terminated with SQLSTATE 57P01.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";

import { callFunction, createDb, isCellWakingError, retryOnPause, waitForWake } from "../src/index";

const url = process.env["CAPYDB_DRIZZLE_TEST_DATABASE_URL"];

/** SQLSTATE or postgres-js errno of a failed promise, or "ok" if it resolved. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    for (let current: unknown = error; current;) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
}

describe.skipIf(url === undefined)("against a real postgres", () => {
  // Assigned in beforeAll; the describe block only runs when url is set.
  let admin: ReturnType<typeof postgres>;
  let db: ReturnType<typeof createDb>;

  /** Terminate every session running a statement that contains `marker`. */
  async function terminate(marker: string): Promise<number> {
    const rows = await admin`
      select pg_terminate_backend(pid) as killed from pg_stat_activity
      where query like ${`%${marker}%`} and pid <> pg_backend_pid()`;
    return rows.length;
  }

  async function waitForStatement(marker: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const rows = await admin`
        select 1 from pg_stat_activity
        where query like ${`%${marker}%`} and state = 'active' and pid <> pg_backend_pid()`;
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`statement ${marker} never started`);
  }

  beforeAll(async () => {
    admin = postgres(url ?? "", { max: 1, onnotice: () => {} });
    // max: 1 is the serverless default behind the pooler, and it makes the
    // dead-connection sequence deterministic: every statement reuses one socket.
    db = createDb({ connectionString: url ?? "", client: { max: 1, onnotice: () => {} } });
    await admin.unsafe(`
      drop schema if exists capydb_drizzle_test cascade;
      create schema capydb_drizzle_test;
      create function capydb_drizzle_test.echo(
        p_text text,
        p_doc jsonb default '{}'::jsonb,
        p_ids int[] default '{}',
        p_suffix text default '!'
      ) returns table (text_out text, doc_out jsonb, id_count int)
      language sql as $$
        select p_text || p_suffix, p_doc, cardinality(p_ids)
      $$;
      create function capydb_drizzle_test.add(a int, b int) returns int
      language sql as $$ select a + b $$;
      create table capydb_drizzle_test.events (id serial primary key, note text not null);
    `);
  });

  afterAll(async () => {
    await admin?.unsafe("drop schema if exists capydb_drizzle_test cascade");
    await db?.$client.end();
    await admin?.end();
  });

  describe("callFunction", () => {
    it("binds named arguments, JSON-encodes objects and sends arrays as arrays", async () => {
      const rows = await callFunction<{ text_out: string; doc_out: unknown; id_count: number }>(
        db,
        "echo",
        { p_text: "capy", p_doc: { tags: ["a", "b"] }, p_ids: [1, 2, 3] },
        { schema: "capydb_drizzle_test" },
      );
      expect(rows).toEqual([{ text_out: "capy!", doc_out: { tags: ["a", "b"] }, id_count: 3 }]);
    });

    it("lets parameter defaults apply for undefined arguments", async () => {
      const rows = await callFunction(
        db,
        "echo",
        { p_text: "capy", p_suffix: undefined },
        { schema: "capydb_drizzle_test" },
      );
      expect(rows[0]?.["text_out"]).toBe("capy!");
    });

    it("returns a scalar function's value in a column named after it", async () => {
      const rows = await callFunction<{ add: number }>(
        db,
        "add",
        { b: 2, a: 40 }, // named notation: order does not matter
        { schema: "capydb_drizzle_test" },
      );
      expect(rows).toEqual([{ add: 42 }]);
    });

    it("runs inside a transaction handle", async () => {
      const rows = await db.transaction((tx) =>
        callFunction<{ add: number }>(tx, "add", { a: 1, b: 1 }, { schema: "capydb_drizzle_test" }),
      );
      expect(rows).toEqual([{ add: 2 }]);
    });

    it("fails loudly when a parameter without a default is left out", async () => {
      await expect(
        callFunction(db, "add", { a: 1, b: undefined }, { schema: "capydb_drizzle_test" }),
      ).rejects.toThrow();
    });
  });

  describe("a pause under an open connection", () => {
    it("fails the statement in flight and the next one, then reconnects", async () => {
      await db.execute(sql`select 1`); // open the connection
      const inFlight = outcome(db.execute(sql`select pg_sleep(5) /* capydb-pause-1 */`));
      await waitForStatement("capydb-pause-1");
      expect(await terminate("capydb-pause-1")).toBe(1);

      // The two failures retryOnPause exists to absorb. Both are recognised.
      expect(await inFlight).toBe("CONNECTION_CLOSED");
      expect(await outcome(db.execute(sql`select 1`))).toBe("57P01");
      // ...and postgres-js has reconnected by the third statement.
      expect(await outcome(db.execute(sql`select 1`))).toBe("ok");
    });

    it("is absorbed by retryOnPause around a read", async () => {
      await db.execute(sql`select 1`);
      let attempts = 0;
      const read = retryOnPause(async () => {
        attempts += 1;
        const rows = await db.execute<{ value: number }>(
          sql`select 7 as value, pg_sleep(${attempts === 1 ? 5 : 0}) /* capydb-pause-2 */`,
        );
        return rows[0]?.value;
      });
      await waitForStatement("capydb-pause-2");
      await terminate("capydb-pause-2");
      await expect(read).resolves.toBe(7);
      expect(attempts).toBe(3);
    });

    it("re-runs a whole transaction exactly once in effect", async () => {
      await db.execute(sql`select 1`);
      let attempts = 0;
      await retryOnPause(() =>
        db.transaction(async (tx) => {
          attempts += 1;
          await tx.execute(sql`insert into capydb_drizzle_test.events (note) values ('once')`);
          if (attempts === 1) {
            // Terminated while idle in the transaction, between two statements.
            // The wait lets postgres-js observe the closed socket before this
            // callback would issue anything else: postgres-js 3.4.9 has a race
            // where a write queued on a socket that closes in the same tick
            // throws from a timer and wedges the client, which is a driver bug
            // this test is not about.
            const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
            await admin`select pg_terminate_backend(${row?.pid ?? 0})`;
            await new Promise((resolve) => setTimeout(resolve, 500));
            return;
          }
          await tx.execute(sql`select 1`);
        }),
      );
      // The killed attempt's insert was rolled back with its transaction.
      const [count] = await admin`
        select count(*)::int as n from capydb_drizzle_test.events where note = 'once'`;
      expect(count?.["n"]).toBe(1);
      expect(attempts).toBeGreaterThan(1);
    });

    it("recognises every failure it produces as a pause condition", async () => {
      await db.execute(sql`select 1`);
      const inFlight = db.execute(sql`select pg_sleep(5) /* capydb-pause-3 */`).then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForStatement("capydb-pause-3");
      await terminate("capydb-pause-3");
      expect(isCellWakingError(await inFlight)).toBe(true);
      const next = await db.execute(sql`select 1`).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(isCellWakingError(next)).toBe(true);
    });
  });

  it("waitForWake returns once the database answers", async () => {
    await expect(waitForWake(db.$client, { attempts: 3 })).resolves.toBeUndefined();
  });
});
