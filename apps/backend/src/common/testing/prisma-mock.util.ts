/**
 * Reading a Prisma write back off a jest mock, without `any`.
 *
 * `jest.Mock['mock']['calls']` is `any[][]`. The `no-unsafe-*` rules exist to
 * stop `any` leaking through code, and a spec asserting on what a service WROTE
 * is exactly where the shape is known and worth stating — so the cast happens
 * once, here, and every spec reads a typed value.
 *
 * Used only by `*.spec.ts`. It lives under `src/` rather than beside one of them
 * because four specs need it, and four copies of a cast is four places for the
 * shape to drift.
 */

type Row = Record<string, unknown>;

/** The whole first argument of one call — `{ where, data, include, … }`. */
export function callArg<T>(mock: jest.Mock, call = 0): T {
  const calls = mock.mock.calls as unknown as T[][];
  return calls[call][0];
}

/** The `data` payload of a `create` or `update` call. */
export function writtenData(mock: jest.Mock, call = 0): Row {
  return callArg<{ data: Row }>(mock, call).data;
}

/** The `data` array of a `createMany` call. */
export function writtenRows(mock: jest.Mock, call = 0): Row[] {
  return callArg<{ data: Row[] }>(mock, call).data;
}
