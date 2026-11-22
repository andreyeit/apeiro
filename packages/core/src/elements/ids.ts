/**
 * Unique element id, `prefix-<uuid>`. Random UUIDs: ids created by different participants
 * at the same millisecond must never collide once boards are shared.
 */
export function newId(prefix: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}
