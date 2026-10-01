// Strict deep merge for config-shaped plain objects: applies `patch` on top of `base` and
// returns a NEW object (neither input is mutated).
//
// "Strict" means the patch must fit the base's shape. That is the whole point of using it for
// remote config: clients ignore keys they don't know, so a typo'd override key would otherwise
// be silently dropped and nobody would notice the flag never flipped. Instead:
//   - a key that doesn't exist in the base  -> throws MergeError (naming the full path)
//   - a primitive of a different type       -> throws (e.g. "true" where a boolean lives)
//   - null                                  -> allowed for any key (clearing a nullable field);
//                                              a base value of null accepts any primitive,
//                                              since the field's type can't be known from null
//   - arrays                                -> replaced wholesale, never merged element-wise
//   - nested objects                        -> merged recursively
//
// Pure: no imports, safe for the check:* scripts.
// (Verbatim from HOA protocol 10's reference implementation.)

// Recursive partial: every key optional, at every depth. Types a patch against the full
// shape so a rule written in TypeScript is checked at compile time as well as at runtime.
export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const describe = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`;

// `path` names where we are, for error messages ("$" = the root, or a caller-chosen label
// such as the env var / rule the patch came from).
export const deepMergeStrict = <T extends object>(base: T, patch: unknown, path = "$"): T => {
  if (!isPlainObject(patch)) {
    throw new MergeError(`${path}: expected an object, got ${describe(patch)}`);
  }
  const baseRecord = base as Record<string, unknown>;
  const out: Record<string, unknown> = { ...baseRecord };

  for (const [key, patchValue] of Object.entries(patch)) {
    const childPath = `${path}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(baseRecord, key)) {
      throw new MergeError(`${childPath}: unknown key`);
    }
    const baseValue = baseRecord[key];

    if (patchValue === null) {
      // Clearing a (nullable) field. Objects can't be cleared this way — they'd leave old
      // clients without a whole section they expect to exist.
      if (isPlainObject(baseValue)) {
        throw new MergeError(`${childPath}: cannot set an object to null`);
      }
      out[key] = null;
      continue;
    }
    if (baseValue === null) {
      // The base can't tell us the type; accept any primitive, never a structure.
      if (isPlainObject(patchValue) || Array.isArray(patchValue)) {
        throw new MergeError(`${childPath}: expected a primitive, got ${describe(patchValue)}`);
      }
      out[key] = patchValue;
      continue;
    }
    if (isPlainObject(baseValue)) {
      out[key] = deepMergeStrict(baseValue, patchValue, childPath);
      continue;
    }
    if (Array.isArray(baseValue)) {
      if (!Array.isArray(patchValue)) {
        throw new MergeError(`${childPath}: expected an array, got ${describe(patchValue)}`);
      }
      out[key] = patchValue;
      continue;
    }
    if (typeof patchValue !== typeof baseValue) {
      throw new MergeError(
        `${childPath}: expected a ${typeof baseValue}, got ${describe(patchValue)}`
      );
    }
    out[key] = patchValue;
  }

  return out as T;
};
