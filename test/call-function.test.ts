import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { callFunction, withAuthContext } from "../src/index";

const dialect = new PgDialect();

/** Records the statement and result mode callFunction hands to `execute`. */
function fakeExecutor(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ query: SQL; mode: unknown }> = [];
  const executor = {
    execute: vi.fn(async (query: SQL, mode?: unknown) => {
      calls.push({ query, mode });
      return rows;
    }),
  };
  return {
    db: executor as unknown as Parameters<typeof callFunction>[0],
    calls,
    render(index = 0) {
      const call = calls[index];
      if (call === undefined) throw new Error(`no statement ${index}`);
      return dialect.sqlToQuery(call.query);
    },
  };
}

describe("callFunction", () => {
  it("calls the function with named, parameterized arguments", async () => {
    const fake = fakeExecutor();
    await callFunction(fake.db, "get_feed", { p_user_id: "u1", p_limit: 20 });
    const { sql, params } = fake.render();
    expect(sql).toBe('select * from "get_feed"("p_user_id" => $1, "p_limit" => $2)');
    expect(params).toEqual(["u1", 20]);
    // "objects" mode is what makes the result a plain array of row objects.
    expect(fake.calls[0]?.mode).toBe("objects");
  });

  it("returns the rows the function produced", async () => {
    const fake = fakeExecutor([{ id: 1 }, { id: 2 }]);
    const rows = await callFunction<{ id: number }>(fake.db, "list_ids");
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("calls a function without arguments", async () => {
    const fake = fakeExecutor();
    await callFunction(fake.db, "now_utc");
    expect(fake.render().sql).toBe('select * from "now_utc"()');
  });

  it("qualifies the function with a schema when asked", async () => {
    const fake = fakeExecutor();
    await callFunction(fake.db, "rollup", {}, { schema: "reporting" });
    expect(fake.render().sql).toBe('select * from "reporting"."rollup"()');
  });

  it("quotes identifiers so names cannot inject SQL", async () => {
    const fake = fakeExecutor();
    await callFunction(fake.db, 'evil"(); drop table users; --', { 'a" => 1); --': 1 });
    const { sql, params } = fake.render();
    expect(sql).toBe('select * from "evil""(); drop table users; --"("a"" => 1); --" => $1)');
    expect(params).toEqual([1]);
  });

  it("leaves undefined arguments out so parameter defaults apply", async () => {
    const fake = fakeExecutor();
    await callFunction(fake.db, "search", { q: "capy", p_limit: undefined, p_after: null });
    const { sql, params } = fake.render();
    expect(sql).toBe('select * from "search"("q" => $1, "p_after" => $2)');
    // An explicit null is still sent: that is how a caller asks for SQL NULL.
    expect(params).toEqual(["capy", null]);
  });

  it("JSON-encodes plain objects and passes arrays, dates and buffers through", async () => {
    const fake = fakeExecutor();
    const when = new Date("2026-09-29T10:00:00Z");
    const bytes = new Uint8Array([1, 2, 3]);
    await callFunction(fake.db, "save", {
      p_doc: { tags: ["a"], nested: { n: 1 } },
      p_ids: [1, 2, 3],
      p_at: when,
      p_blob: bytes,
    });
    const { params } = fake.render();
    expect(params).toEqual(['{"tags":["a"],"nested":{"n":1}}', [1, 2, 3], when, bytes]);
  });

  it("rejects an empty function or schema name before touching the database", async () => {
    const fake = fakeExecutor();
    await expect(callFunction(fake.db, "")).rejects.toThrow(/needs a function name/);
    await expect(callFunction(fake.db, "f", {}, { schema: "" })).rejects.toThrow(
      /schema option must not be empty/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("accepts the transaction handle withAuthContext passes to its callback", async () => {
    const fake = fakeExecutor([{ ok: true }]);
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute: async (query: SQL, mode?: unknown) => {
            fake.calls.push({ query, mode });
            return [{ ok: true }];
          },
        }),
    } as unknown as Parameters<typeof withAuthContext>[0];
    // Compiles only if a transaction handle satisfies callFunction's executor type.
    const rows = await withAuthContext(db, {}, (tx) => callFunction(tx, "check"));
    expect(rows).toEqual([{ ok: true }]);
    expect(fake.render().sql).toBe('select * from "check"()');
  });
});
