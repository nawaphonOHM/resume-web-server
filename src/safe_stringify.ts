/**
 * Safe string conversion utilities.
 *
 * @packageDocumentation
 */

function stringifyError(err: Error): string {
  return err.message.length > 0 ? err.message : err.name;
}

function stringifyJson(value: object): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[Unserializable Object]';
  }
}

function isStringOrBigInt(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'bigint';
}

function isNumberOrBool(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'boolean';
}

function formatBasicPrimitive(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function stringifyPrimitive(value: unknown): string {
  if (typeof value === 'symbol') {
    return value.toString();
  }
  return value === undefined ? 'undefined' : 'null';
}

function stringifyObject(value: object): string {
  if (value instanceof Error) {
    return stringifyError(value);
  }
  return stringifyJson(value);
}

function isScalar(value: unknown): boolean {
  if (isStringOrBigInt(value)) {
    return true;
  }
  return isNumberOrBool(value);
}

function isNonNullObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * Safely converts an unknown value to a string representation without returning `[object Object]`.
 *
 * @param value - Any value.
 * @returns Safe string representation.
 */
export function safeStringify(value: unknown): string {
  if (isScalar(value)) {
    return formatBasicPrimitive(value);
  }
  if (isNonNullObject(value)) {
    return stringifyObject(value);
  }
  return stringifyPrimitive(value);
}
