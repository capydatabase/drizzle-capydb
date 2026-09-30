import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPooledStartupParameters,
  isPooledUrl,
  resolveClientOptions,
  resolveConnectionString,
} from "../src/index";

const POOLED_URL = "postgresql://app:secret@proj.db.capydb.dev:6432/appdb?sslmode=require";
const DIRECT_URL = "postgresql://app:secret@proj.db.capydb.dev:5432/appdb?sslmode=require";

describe("resolveConnectionString", () => {
  it("prefers the explicit connection string over env vars", () => {
    const url = resolveConnectionString("postgres://explicit", ["DATABASE_URL"], {
      DATABASE_URL: "postgres://from-env",
    });
    expect(url).toBe("postgres://explicit");
  });

  it("checks env vars in order and returns the first non-empty value", () => {
    const env = {
      CAPYDB_DATABASE_URL: "postgres://capydb-var",
      DATABASE_URL: "postgres://plain-var",
    };
    expect(resolveConnectionString(undefined, ["CAPYDB_DATABASE_URL", "DATABASE_URL"], env)).toBe(
      "postgres://capydb-var",
    );
    expect(resolveConnectionString(undefined, ["DATABASE_URL", "CAPYDB_DATABASE_URL"], env)).toBe(
      "postgres://plain-var",
    );
  });

  it("skips empty-string env values", () => {
    const env = { CAPYDB_DATABASE_URL: "", DATABASE_URL: "postgres://fallback" };
    expect(resolveConnectionString(undefined, ["CAPYDB_DATABASE_URL", "DATABASE_URL"], env)).toBe(
      "postgres://fallback",
    );
  });

  it("treats an empty explicit string as absent", () => {
    const env = { DATABASE_URL: "postgres://fallback" };
    expect(resolveConnectionString("", ["DATABASE_URL"], env)).toBe("postgres://fallback");
  });

  it("throws an error naming every checked source when nothing is set", () => {
    expect(() =>
      resolveConnectionString(undefined, ["CAPYDB_DATABASE_URL", "DATABASE_URL"], {}),
    ).toThrowError(/connectionString.*CAPYDB_DATABASE_URL, DATABASE_URL/s);
  });
});

describe("isPooledUrl", () => {
  it("detects the pooled port 6432", () => {
    expect(isPooledUrl(POOLED_URL)).toBe(true);
  });

  it("treats the direct port 5432 as not pooled", () => {
    expect(isPooledUrl(DIRECT_URL)).toBe(false);
  });

  it("treats a URL without a port as not pooled", () => {
    expect(isPooledUrl("postgresql://app@proj.db.capydb.dev/appdb")).toBe(false);
  });

  it("is not fooled by 6432 appearing in credentials or database name", () => {
    expect(isPooledUrl("postgresql://user6432:pw@host:5432/db6432")).toBe(false);
  });

  it("falls back to port matching for non-URL-parseable strings", () => {
    expect(isPooledUrl("host:6432")).toBe(true);
    expect(isPooledUrl("host:5432")).toBe(false);
  });
});

describe("resolveClientOptions", () => {
  it("defaults to prepare:false and max:1 for pooled URLs", () => {
    expect(resolveClientOptions(POOLED_URL, undefined)).toEqual({ prepare: false, max: 1 });
  });

  it("defaults to max:10 (prepared statements untouched) for direct URLs", () => {
    expect(resolveClientOptions(DIRECT_URL, undefined)).toEqual({ max: 10 });
  });

  it("honours pooled:true even when the URL targets the direct port", () => {
    expect(resolveClientOptions(DIRECT_URL, true)).toEqual({ prepare: false, max: 1 });
  });

  it("honours pooled:false even when the URL targets the pooled port", () => {
    expect(resolveClientOptions(POOLED_URL, false)).toEqual({ max: 10 });
  });

  it("lets caller overrides win over defaults key-by-key", () => {
    expect(resolveClientOptions(POOLED_URL, undefined, { max: 2, idle_timeout: 20 })).toEqual({
      prepare: false,
      max: 2,
      idle_timeout: 20,
    });
  });

  it("allows overriding prepare (caller opts in at their own risk)", () => {
    expect(resolveClientOptions(POOLED_URL, undefined, { prepare: true })).toEqual({
      prepare: true,
      max: 1,
    });
  });
});

describe("pooled startup parameter guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes tracked params (application_name etc.) through silently", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      resolveClientOptions(POOLED_URL, undefined, {
        connection: { application_name: "ermis", client_encoding: "utf8" },
      }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns that pooler-ignored params like statement_timeout are not applied", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveClientOptions(POOLED_URL, undefined, {
      connection: { statement_timeout: 10_000 },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("statement_timeout");
    expect(warn.mock.calls[0]?.[0]).toContain("ALTER ROLE");
  });

  it("passes search_path through silently (tracked since PgBouncer 1.26)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      resolveClientOptions(POOLED_URL, undefined, {
        connection: { search_path: "tenant_42" },
      }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws for params the pooler rejects at handshake (default_transaction_read_only)", () => {
    expect(() =>
      resolveClientOptions(POOLED_URL, undefined, {
        connection: { default_transaction_read_only: true },
      }),
    ).toThrow(/default_transaction_read_only.*unsupported startup parameter/s);
  });

  it("skips undefined/null values and does not guard direct clients", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      resolveClientOptions(POOLED_URL, undefined, {
        connection: { default_transaction_read_only: undefined },
      }),
    ).not.toThrow();
    expect(() =>
      resolveClientOptions(DIRECT_URL, undefined, {
        connection: { default_transaction_read_only: true, statement_timeout: 10_000 },
      }),
    ).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is exported for direct use and reports every offending param", () => {
    expect(() =>
      assertPooledStartupParameters({ work_mem: "64MB", default_transaction_read_only: "on" }),
    ).toThrow(/work_mem, default_transaction_read_only/);
  });
});
