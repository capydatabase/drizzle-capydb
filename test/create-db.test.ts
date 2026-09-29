import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, createDirectDb } from "../src/index";

const postgresMock = vi.hoisted(() => vi.fn(() => ({ __mockSql: true })));
// drizzle-orm v1 driver signature: one config object carrying the client.
const drizzleMock = vi.hoisted(() =>
  vi.fn((config: { client: unknown }) => ({ __mockDb: true, $client: config.client, config })),
);

vi.mock("postgres", () => ({ default: postgresMock }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle: drizzleMock }));

const POOLED_URL = "postgresql://app:secret@proj.db.capydb.dev:6432/appdb?sslmode=require";
const DIRECT_URL = "postgresql://app:secret@proj.db.capydb.dev:5432/appdb?sslmode=require";

// Every variable createDb/createDirectDb resolve from. Clearing them first keeps
// a developer's exported DATABASE_URL (or CAPYDB_*) from deciding which one wins.
const CONNECTION_ENV_VARS = [
  "CAPYDB_DATABASE_URL",
  "DATABASE_URL",
  "CAPYDB_DATABASE_DIRECT_URL",
  "DATABASE_DIRECT_URL",
] as const;

beforeEach(() => {
  for (const name of CONNECTION_ENV_VARS) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  postgresMock.mockClear();
  drizzleMock.mockClear();
});

describe("createDb", () => {
  it("builds a pooled-safe client from an explicit pooled connection string", () => {
    const db = createDb({ connectionString: POOLED_URL });
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith(POOLED_URL, { prepare: false, max: 1 });
    expect(drizzleMock).toHaveBeenCalledExactlyOnceWith({
      client: postgresMock.mock.results[0]?.value,
      relations: undefined,
      logger: undefined,
      jit: undefined,
    });
    expect(db.$client).toEqual({ __mockSql: true });
  });

  it("resolves CAPYDB_DATABASE_URL before DATABASE_URL", () => {
    vi.stubEnv("CAPYDB_DATABASE_URL", POOLED_URL);
    vi.stubEnv("DATABASE_URL", "postgres://should-not-be-used");
    createDb();
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith(POOLED_URL, { prepare: false, max: 1 });
  });

  it("falls back to DATABASE_URL and applies direct defaults for :5432 URLs", () => {
    vi.stubEnv("DATABASE_URL", DIRECT_URL);
    createDb();
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith(DIRECT_URL, { max: 10 });
  });

  it("does not consult DATABASE_DIRECT_URL", () => {
    vi.stubEnv("DATABASE_DIRECT_URL", DIRECT_URL);
    expect(() => createDb()).toThrowError(/CAPYDB_DATABASE_URL, DATABASE_URL/);
  });

  it("forwards relations and logger to drizzle and spreads client overrides", () => {
    const relations = { users: { __relations: true } } as never;
    createDb({
      connectionString: POOLED_URL,
      relations,
      logger: true,
      client: { max: 2 },
    });
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith(POOLED_URL, { prepare: false, max: 2 });
    expect(drizzleMock).toHaveBeenCalledExactlyOnceWith({
      client: postgresMock.mock.results[0]?.value,
      relations,
      logger: true,
      jit: undefined,
    });
  });

  it("applies pooled defaults when pooled:true is set on a portless URL", () => {
    const url = "postgresql://app@proj.db.capydb.dev/appdb";
    createDb({ connectionString: url, pooled: true });
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith(url, { prepare: false, max: 1 });
  });
});

describe("createDirectDb", () => {
  it("resolves CAPYDB_DATABASE_DIRECT_URL before DATABASE_DIRECT_URL", () => {
    vi.stubEnv("CAPYDB_DATABASE_DIRECT_URL", DIRECT_URL);
    vi.stubEnv("DATABASE_DIRECT_URL", "postgres://should-not-be-used");
    createDirectDb();
    expect(postgresMock).toHaveBeenCalledExactlyOnceWith(DIRECT_URL, { max: 10 });
  });

  it("never falls back to the pooled DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", POOLED_URL);
    expect(() => createDirectDb()).toThrowError(/CAPYDB_DATABASE_DIRECT_URL, DATABASE_DIRECT_URL/);
  });

  it("rejects a pooled URL before constructing a migration client", () => {
    vi.stubEnv("DATABASE_DIRECT_URL", POOLED_URL);
    expect(() => createDirectDb()).toThrowError(/requires a direct Postgres connection/);
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it("rejects an explicitly pooled portless URL", () => {
    expect(() =>
      createDirectDb({ connectionString: "postgresql://app@host/app", pooled: true }),
    ).toThrowError(/requires a direct Postgres connection/);
    expect(postgresMock).not.toHaveBeenCalled();
  });
});
