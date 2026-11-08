import { describe, expect, it } from "vitest";

import {
  batchClientOptions,
  describeQueryError,
  formatQueryError,
  isTransientQueryError,
} from "../src/index";

/** The shape postgres-js's PostgresError and pg's DatabaseError share. */
function driverError(
  code: string,
  message: string,
  extra: { detail?: string; hint?: string; where?: string } = {},
) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** The shape of drizzle-orm's DrizzleQueryError (query, params, cause). */
function drizzleError(query: string, params: unknown[], cause: unknown) {
  return Object.assign(new Error(`Failed query: ${query}\nparams: ${params}`), {
    name: "DrizzleQueryError",
    query,
    params,
    cause,
  });
}

// The 2026-11-08 ludography incident: one bad day-00 date in a VALUES batch.
const dateError = () =>
  drizzleError(
    '\n      update "games" g set\n        release_year = coalesce(g.release_year, v.year),\n        first_release_at = coalesce(g.first_release_at, v.date)\n      from (values ($1::int, $2::smallint, $3::date)) as v(id, year, date)\n      where g.id = v.id',
    [...Array.from({ length: 2255 }, (_, i) => i), "1992-10-00"],
    driverError("22008", 'date/time field value out of range: "1992-10-00"', {
      hint: 'Perhaps you need a different "DateStyle" setting.',
      where: "unnamed portal parameter $2256 = '...'",
    }),
  );

describe("describeQueryError", () => {
  it("reads the SQLSTATE, class and offending parameter through DrizzleQueryError", () => {
    const described = describeQueryError(dateError());
    expect(described).toMatchObject({
      sqlstate: "22008",
      class: "data_exception",
      retryable: false,
      message: 'date/time field value out of range: "1992-10-00"',
      hint: 'Perhaps you need a different "DateStyle" setting.',
      where: "unnamed portal parameter $2256 = '...'",
      parameter: { index: 2256, value: "1992-10-00" },
    });
    expect(described?.query).toMatch(/^update "games" g set release_year/);
    expect(described?.query?.length).toBeLessThanOrEqual(201);
    expect(described?.query?.endsWith("…")).toBe(true);
  });

  it("reads a bare driver error and a nested cause chain", () => {
    const bare = describeQueryError(
      driverError("23505", 'duplicate key value violates unique constraint "games_qid_key"', {
        detail: "Key (qid)=(Q1234) already exists.",
      }),
    );
    expect(bare).toMatchObject({
      sqlstate: "23505",
      class: "integrity_constraint_violation",
      retryable: false,
      detail: "Key (qid)=(Q1234) already exists.",
    });
    expect(bare?.query).toBeUndefined();
    expect(bare?.parameter).toBeUndefined();

    const wrapped = describeQueryError(new Error("step facts failed", { cause: dateError() }));
    expect(wrapped?.sqlstate).toBe("22008");
    expect(wrapped?.parameter?.index).toBe(2256);
  });

  it("ignores a parameter reference the params list cannot satisfy", () => {
    const described = describeQueryError(
      drizzleError(
        "select $1",
        ["x"],
        driverError("22P02", "invalid input", { where: "parameter $7 = 'y'" }),
      ),
    );
    expect(described?.parameter).toBeUndefined();
    expect(described?.where).toBe("parameter $7 = 'y'");
  });

  it("falls back to the message for non-driver errors and gives up on junk", () => {
    expect(describeQueryError(new Error("boom"))).toMatchObject({
      message: "boom",
      retryable: false,
    });
    expect(describeQueryError(null)).toBeUndefined();
    expect(describeQueryError("nope")).toBeUndefined();
    expect(describeQueryError({})).toBeUndefined();
  });

  it("does not report driver codes that are not SQLSTATEs as one", () => {
    const described = describeQueryError(driverError("ECONNRESET", "read ECONNRESET"));
    expect(described?.sqlstate).toBeUndefined();
    expect(described?.retryable).toBe(true);
  });
});

describe("isTransientQueryError", () => {
  it("is true for pause/resume, connection, rollback and limit conditions", () => {
    for (const code of [
      "57P01",
      "57P02",
      "57P03",
      "08006",
      "08001",
      "08P01",
      "40001",
      "40P01",
      "53300",
      "ECONNRESET",
      "CONNECTION_CLOSED",
    ]) {
      expect(isTransientQueryError(driverError(code, code)), code).toBe(true);
    }
    expect(
      isTransientQueryError(
        drizzleError("select 1", [], driverError("40P01", "deadlock detected")),
      ),
    ).toBe(true);
  });

  it("is false for errors that repeat on every attempt", () => {
    for (const code of [
      "22008",
      "22P02",
      "23505",
      "23503",
      "42P01",
      "42601",
      "42501",
      "57014",
      "53100",
      "28P01",
    ]) {
      expect(isTransientQueryError(driverError(code, code)), code).toBe(false);
    }
    expect(isTransientQueryError(dateError())).toBe(false);
    expect(isTransientQueryError(new Error("no code"))).toBe(false);
    expect(isTransientQueryError(undefined)).toBe(false);
  });
});

describe("formatQueryError", () => {
  it("prints one line with the code, class, parameter, verdict and query", () => {
    const line = formatQueryError(dateError());
    expect(line).toMatch(
      /^22008 data_exception: date\/time field value out of range: "1992-10-00" \(parameter \$2256 = '1992-10-00'; not retryable\) — query: update "games" g set/,
    );
    expect(line).not.toContain("\n");
  });

  it("marks transient errors and includes DETAIL", () => {
    expect(
      formatQueryError(
        driverError("40P01", "deadlock detected", { detail: "Process 1 waits for ..." }),
      ),
    ).toBe(
      "40P01 transaction_rollback: deadlock detected (detail: Process 1 waits for ...; retryable)",
    );
  });

  it("falls back to the plain message", () => {
    expect(formatQueryError(new Error("boom"))).toBe("boom (not retryable)");
    expect(formatQueryError("nope")).toBe("nope");
  });
});

describe("batchClientOptions", () => {
  it("builds a small, named, bounded pool", () => {
    expect(batchClientOptions({ applicationName: "ingest", statementTimeoutMs: 300_000 })).toEqual({
      max: 3,
      idle_timeout: 60,
      connection: { application_name: "ingest", statement_timeout: "300000" },
    });
  });

  it("leaves statement_timeout out when not asked for and honours max", () => {
    expect(batchClientOptions({ applicationName: "copy", max: 1 })).toEqual({
      max: 1,
      idle_timeout: 60,
      connection: { application_name: "copy" },
    });
  });

  it("rejects a non-positive or fractional timeout", () => {
    expect(() => batchClientOptions({ applicationName: "x", statementTimeoutMs: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => batchClientOptions({ applicationName: "x", statementTimeoutMs: 1.5 })).toThrow(
      /positive integer/,
    );
  });
});
