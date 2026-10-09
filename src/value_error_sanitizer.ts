/**
 * Recursive error sanitization for structured log payloads.
 *
 * @packageDocumentation
 */

import { isErrorObject } from './error/error_inspector.ts';
import { sanitizeErrorForLog } from './error/error_sanitizer.ts';
import { safeStringify } from './safe_stringify.ts';

function isNullOrUndefined(value: unknown): boolean {
  return value === null || value === undefined;
}

function isSimpleScalar(value: unknown): boolean {
  const t = typeof value;
  return t === 'string' || t === 'number';
}

function isBoolOrSymbol(value: unknown): boolean {
  const t = typeof value;
  return t === 'boolean' || t === 'symbol';
}

function isPreservedPrimitive(value: unknown): boolean {
  if (isNullOrUndefined(value)) return true;
  return isSimpleScalar(value) || isBoolOrSymbol(value);
}

function sanitizeNestedRecord(
  rec: Record<string, unknown>,
  visited: Set<unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    result[k] = sanitizeAllErrorsInValue(v, visited);
  }
  return result;
}

function sanitizeContainer(value: object, visited: Set<unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAllErrorsInValue(item, visited));
  }
  if (typeof value === 'object') {
    return sanitizeNestedRecord(value as Record<string, unknown>, visited);
  }
  return safeStringify(value);
}

function isErrorLikeValue(value: unknown): boolean {
  return value instanceof Error || isErrorObject(value);
}

function sanitizeObjectLike(value: object, visited: Set<unknown>): unknown {
  if (visited.has(value)) {
    return '[Circular]';
  }
  if (isErrorLikeValue(value)) {
    return sanitizeErrorForLog(value, visited);
  }
  visited.add(value);
  return sanitizeContainer(value, visited);
}

function sanitizeNonPrimitive(value: unknown, visited: Set<unknown>): unknown {
  if (typeof value === 'bigint') {
    return String(value);
  }
  return sanitizeObjectLike(value as object, visited);
}

/**
 * Recursively inspects a value (object or array) and replaces any Error or Error-like objects with sanitized summaries.
 * Retains benign metadata intact while protecting against deep credential leaks.
 *
 * @param value - Value to inspect and sanitize.
 * @param visited - Set tracking visited references.
 * @returns Deeply sanitized value with safe error representations.
 */
export function sanitizeAllErrorsInValue(value: unknown, visited?: Set<unknown>): unknown {
  if (isPreservedPrimitive(value)) {
    return value;
  }
  return sanitizeNonPrimitive(value, visited ?? new Set<unknown>());
}
