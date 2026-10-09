/**
 * Error inspection and duck typing utilities.
 *
 * @packageDocumentation
 */

function hasErrorStackPattern(rec: Record<string, unknown>): boolean {
  const stack = rec['stack'];
  return typeof stack === 'string' && /\n\s+at\s+/.test(stack);
}

function hasErrorIdentifier(rec: Record<string, unknown>): boolean {
  return typeof rec['message'] === 'string' || typeof rec['name'] === 'string';
}

function isDuckTypedError(val: object): boolean {
  if (Object.prototype.toString.call(val) === '[object Error]') {
    return true;
  }
  const rec = val as Record<string, unknown>;
  return hasErrorStackPattern(rec) && hasErrorIdentifier(rec);
}

function isObjectReference(val: unknown): val is object {
  return typeof val === 'object' && val !== null;
}

/**
 * Determines whether a value is an Error instance or cross-realm Error object with a stack trace.
 *
 * @param val - Value to check.
 * @returns True if value is an Error or Error-like object.
 */
export function isErrorObject(val: unknown): boolean {
  if (val instanceof Error) {
    return true;
  }
  return isObjectReference(val) && isDuckTypedError(val);
}

function isNonEmptyString(val: unknown): boolean {
  return typeof val === 'string' && val.trim().length > 0;
}

function isPlainErrorRecord(val: unknown): boolean {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isErrorInstanceOrLike(val: unknown): boolean {
  return val instanceof Error || isErrorObject(val);
}

function isPotentialPayload(val: unknown): boolean {
  return isNonEmptyString(val) || isPlainErrorRecord(val);
}

/**
 * Checks whether a value represents an error (Error instance, error-like object, non-empty error string, or error object).
 * Returns false for falsy values, numbers, and boolean values like `false` or `0`.
 *
 * @param val - Value to check.
 * @returns True if value is an error or potential error payload.
 */
export function isPotentialError(val: unknown): boolean {
  if (!val) {
    return false;
  }
  return isErrorInstanceOrLike(val) || isPotentialPayload(val);
}
