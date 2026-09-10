import type { NextFunction, Request, Response } from "express";

/**
 * Express error middleware that names the cause of an unexpected 500 before
 * `errorHandler` swallows it. Mount it immediately before `errorHandler`.
 *
 * `errorHandler` answers an unhandled throw with a fixed
 * `{"error":"Internal server error"}` body and logs nothing itself — only
 * `httpLogger` prints the context it attaches, and route unit tests do not
 * mount `httpLogger`. Without this middleware a crash inside a route reports
 * exactly `expected 200 "OK", got 500 "Internal Server Error"` and nothing
 * else, and the cause has to be reconstructed from CI log archaeology after
 * the fact. That is how the concurrent-`vi.importActual` mock race described
 * in `no-concurrent-module-imports.test.ts` stayed unexplained for weeks.
 *
 * Vitest suppresses console output for passing tests and surfaces it for
 * failing ones, so this costs nothing on a green run.
 *
 * Deliberate 4xx outcomes (`HttpError`, Zod validation) are the normal
 * business of these suites and stay quiet. The 4xx filter is deliberately
 * structural rather than `err instanceof HttpError`: these suites call
 * `vi.resetModules()`, so the `HttpError` class a route throws can come from
 * a different module registry than the one this file imported, and
 * `instanceof` then reports false for a genuine `HttpError`.
 */
export function reportUnexpectedRouteError(label: string) {
  return (err: unknown, _req: Request, _res: Response, next: NextFunction) => {
    const status = (err as { status?: unknown } | null)?.status;
    const name = (err as { name?: unknown } | null)?.name;
    const isExpectedRejection = (typeof status === "number" && status < 500) || name === "ZodError";
    if (!isExpectedRejection) {
      // eslint-disable-next-line no-console
      console.error(`[${label}] route threw an unexpected error`, err);
    }
    next(err);
  };
}
