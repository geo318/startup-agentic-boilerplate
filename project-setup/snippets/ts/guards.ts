// Boundary helpers: they take `unknown` and use `typeof` on purpose. Exempt this file from the
// anti-slop oxlint rules (see SKILL.md, "Wire tooling"); fallow health already ignores it.

type TypeGuard<V> = (value: unknown) => value is V;

type Shape = Record<string, TypeGuard<unknown>>;

type InferShape<S extends Shape> = {
  [K in keyof S]: S[K] extends TypeGuard<infer V> ? V : never;
};

/** Narrow `unknown` without assertions. Use a schema library for anything larger than a few keys. */
export const Guard = {
  string(value: unknown): value is string {
    return typeof value === "string";
  },

  number(value: unknown): value is number {
    return typeof value === "number" && !Number.isNaN(value);
  },

  boolean(value: unknown): value is boolean {
    return typeof value === "boolean";
  },

  object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  },

  array(value: unknown): value is unknown[] {
    return Array.isArray(value);
  },

  shape<S extends Shape>(shape: S): TypeGuard<InferShape<S>> {
    return (value: unknown): value is InferShape<S> => {
      if (!Guard.object(value)) {
        return false;
      }
      for (const key in shape) {
        const guard = shape[key];
        if (guard && !guard(value[key])) {
          return false;
        }
      }
      return true;
    };
  },
} as const;

export function hasKey<K extends string>(input: unknown, key: K): input is Record<K, unknown>;
export function hasKey<K extends string, V>(
  input: unknown,
  key: K,
  guard: TypeGuard<V>,
): input is Record<K, V>;
export function hasKey<K extends string, V>(
  input: unknown,
  key: K,
  guard?: TypeGuard<V>,
): input is Record<K, unknown> {
  if (!Guard.object(input) || !(key in input)) {
    return false;
  }
  return guard ? guard(input[key]) : true;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (hasKey(error, "message", Guard.string)) {
    return error.message;
  }
  return String(error);
}
