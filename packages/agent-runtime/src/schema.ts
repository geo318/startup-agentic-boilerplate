// One validator for the canonical JSON Schemas in /schemas. Supports only the keywords we use; an unknown
// keyword in a schema throws, so a schema can never silently weaken what it appears to enforce.
type S = Record<string, unknown>;
const KEYWORDS = new Set([
  "$schema", "$id", "title", "description", "type", "enum", "const", "properties", "required", "additionalProperties",
  "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "pattern", "oneOf", "propertyNames", "default",
]);

export function validate(schema: S, value: unknown, path = "$"): string[] {
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) throw new Error(`unsupported schema keyword: ${k}`);
  const errs: string[] = [];
  const fail = (m: string) => errs.push(`${path}: ${m}`);
  if ("const" in schema && value !== schema.const) fail(`must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail(`must be one of ${JSON.stringify(schema.enum)}`);
  if (Array.isArray(schema.oneOf)) {
    const ok = (schema.oneOf as S[]).filter((s) => validate(s, value, path).length === 0).length;
    if (ok !== 1) fail(`must match exactly one alternative (matched ${ok})`);
  }
  const t = schema.type as string | undefined;
  if (t) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    if (!(actual === t || (t === "number" && actual === "integer"))) return [...errs, `${path}: expected ${t}, got ${actual}`];
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) fail(`shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) fail(`longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) fail(`must match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("must be finite");
    if (typeof schema.minimum === "number" && value < schema.minimum) fail(`below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) fail(`above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items as S, v, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, S>;
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in o)) fail(`missing required "${r}"`);
    for (const [k, v] of Object.entries(o)) {
      if (props[k]) errs.push(...validate(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) fail(`unknown field "${k}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errs.push(...validate(schema.additionalProperties as S, v, `${path}.${k}`));
    }
    if (schema.propertyNames) for (const k of Object.keys(o)) errs.push(...validate(schema.propertyNames as S, k, `${path}{${k}}`));
  }
  return errs;
}
