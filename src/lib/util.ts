
export function countUnique(xs: string[]): number {
  const m = new Set<string>();
  xs.forEach((x) => m.add(x));
  return m.size;
}

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };
export function Err<T, E>(e: E): Result<T, E> {
  return { ok: false, error: e };
}
export function Ok<T, E>(x: T): Result<T, E> {
  return { ok: true, value: x };
}

export function unwrap<A, E>(x: Result<A, E>): A {
  if (x.ok == true) {
    return x.value;
  } else {
    throw x.error;
  }
}

