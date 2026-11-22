// Inline plain configuration objects compare by value. Functions and class instances
// (including documents) compare by identity; they cannot be serialized safely.
export function configKey(value: unknown, ancestors = new Set<object>()): unknown[] {
  if (!value || typeof value !== 'object') return [value];
  const plain =
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
  if ((!plain && !Array.isArray(value)) || ancestors.has(value)) return [value];
  ancestors.add(value);
  const keys = Object.keys(value).sort();
  const result: unknown[] = [Array.isArray(value) ? 'array' : 'object', keys.length];
  for (const key of keys)
    result.push(key, ...configKey((value as Record<string, unknown>)[key], ancestors));
  ancestors.delete(value);
  return result;
}
