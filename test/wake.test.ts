import { describe, expect, it, vi } from "vitest";

import { CellPausedError, isCellWakingError, retryOnPause, waitForWake } from "../src/index";

/** Minimal stand-in for the postgres-js tagged-template client. */
function fakeClient(behaviours: Array<Error | "ok">) {
  let call = 0;
  const client = (() => {
    const outcome = behaviours[Math.min(call, behaviours.length - 1)];
    call += 1;
    return outcome === "ok" ? Promise.resolve([{ "?column?": 1 }]) : Promise.reject(outcome);
  }) as unknown as Parameters<typeof waitForWake>[0];
  return {
    client,
    get calls() {
      return call;
    },
  };
}

const pgError = (code: string) => Object.assign(new Error(`pg error ${code}`), { code });

describe("isCellWakingError", () => {
  it("treats pause/resume conditions as transient", () => {
    // The cell was paused mid-session by the idle sweep.
    expect(isCellWakingError(pgError("57P01"))).toBe(true);
    // Still resuming.
    expect(isCellWakingError(pgError("57P03"))).toBe(true);
    expect(isCellWakingError(pgError("ECONNRESET"))).toBe(true);
    // What postgres-js reports for a statement in flight when the cell pauses.
    expect(isCellWakingError(pgError("CONNECTION_CLOSED"))).toBe(true);
  });

  it("does not treat a client the application closed itself as transient", () => {
    // sql.end() / sql.close() - retrying would only hit the same closed client.
    expect(isCellWakingError(pgError("CONNECTION_ENDED"))).toBe(false);
    expect(isCellWakingError(pgError("CONNECTION_DESTROYED"))).toBe(false);
  });

  it("does not treat real SQL failures as transient", () => {
    expect(isCellWakingError(pgError("42601"))).toBe(false); // syntax error
    expect(isCellWakingError(pgError("23505"))).toBe(false); // unique violation
    expect(isCellWakingError(pgError("28P01"))).toBe(false); // bad password
    expect(isCellWakingError(new Error("boom"))).toBe(false);
    expect(isCellWakingError(undefined)).toBe(false);
  });

  it("unwraps a nested cause", () => {
    const wrapped = new Error("connection failed", { cause: pgError("57P01") });
    expect(isCellWakingError(wrapped)).toBe(true);
  });

  it("does not loop forever on a self-referential cause", () => {
    const selfRef = new Error("weird") as Error & { cause?: unknown };
    selfRef.cause = selfRef;
    expect(isCellWakingError(selfRef)).toBe(false);
  });
});

describe("waitForWake", () => {
  it("returns as soon as the cell answers", async () => {
    // Note: read `fake.calls` through the object - destructuring would snapshot
    // the getter's value at zero.
    const fake = fakeClient(["ok"]);
    await waitForWake(fake.client);
    expect(fake.calls).toBe(1);
  });

  it("retries transient errors then succeeds", async () => {
    vi.useFakeTimers();
    const fake = fakeClient([pgError("57P03"), pgError("57P03"), "ok"]);
    const pending = waitForWake(fake.client, { baseDelayMs: 1 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(fake.calls).toBe(3);
    vi.useRealTimers();
  });

  it("rethrows a non-transient error immediately without retrying", async () => {
    const fake = fakeClient([pgError("28P01")]);
    await expect(waitForWake(fake.client)).rejects.toThrow("28P01");
    // Bad credentials will never become good; retrying would just stall CI.
    expect(fake.calls).toBe(1);
  });

  it("gives up after the attempt budget with a CellPausedError", async () => {
    vi.useFakeTimers();
    const fake = fakeClient([pgError("57P03")]);
    const pending = waitForWake(fake.client, { attempts: 3, baseDelayMs: 1 });
    const assertion = expect(pending).rejects.toThrow("did not become ready after 3 attempts");
    await vi.runAllTimersAsync();
    await assertion;
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CellPausedError);
    expect(fake.calls).toBe(3);
    vi.useRealTimers();
  });

  it("honours an abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeClient(["ok"]);
    await expect(waitForWake(fake.client, { signal: controller.signal })).rejects.toThrow();
    expect(fake.calls).toBe(0);
  });
});

/** An operation that fails with each error in turn, then resolves with `value`. */
function flaky<T>(failures: Error[], value: T) {
  let call = 0;
  const operation = vi.fn(async () => {
    const failure = failures[call];
    call += 1;
    if (failure !== undefined) throw failure;
    return value;
  });
  return operation;
}

describe("retryOnPause", () => {
  it("returns the result without retrying when nothing fails", async () => {
    const operation = flaky([], "rows");
    await expect(retryOnPause(operation)).resolves.toBe("rows");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("rides out the two failures a pause produces with the default budget", async () => {
    vi.useFakeTimers();
    // In flight: CONNECTION_CLOSED. Next statement: the server's 57P01. Then a
    // fresh connection works.
    const operation = flaky([pgError("CONNECTION_CLOSED"), pgError("57P01")], "rows");
    const pending = retryOnPause(operation);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("rows");
    expect(operation).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("finds the pause error behind drizzle's query-error wrapper", async () => {
    vi.useFakeTimers();
    const wrapped = new Error("Failed query: select 1", { cause: pgError("57P01") });
    const operation = flaky([wrapped], "rows");
    const pending = retryOnPause(operation);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("rows");
    vi.useRealTimers();
  });

  it("rethrows a real error on the first attempt, untouched", async () => {
    const unique = pgError("23505");
    const operation = flaky([unique], "rows");
    await expect(retryOnPause(operation)).rejects.toBe(unique);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("throws CellPausedError with the last pause error as its cause", async () => {
    vi.useFakeTimers();
    const last = pgError("57P01");
    const operation = flaky([pgError("CONNECTION_CLOSED"), pgError("57P01"), last], "rows");
    const pending = retryOnPause(operation).catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toBeInstanceOf(CellPausedError);
    if (!(error instanceof CellPausedError)) throw new Error("unreachable");
    expect(error.attempts).toBe(3);
    expect(error.cause).toBe(last);
    expect(error.message).toContain("57P01");
    // Still recognisable as a pause condition to an outer retry policy.
    expect(isCellWakingError(error)).toBe(true);
    vi.useRealTimers();
  });

  it("honours a custom attempt budget", async () => {
    vi.useFakeTimers();
    const operation = flaky([pgError("57P01"), pgError("57P01"), pgError("57P01")], "rows");
    const pending = retryOnPause(operation, { attempts: 4, baseDelayMs: 1 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("rows");
    expect(operation).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("stops before the next attempt once the signal aborts", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => {
      controller.abort();
      throw pgError("57P01");
    });
    await expect(retryOnPause(operation, { signal: controller.signal })).rejects.toThrow();
    expect(operation).toHaveBeenCalledOnce();
  });
});
