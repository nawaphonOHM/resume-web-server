/**
 * Diagnostic error field filtering and sanitization.
 *
 * @packageDocumentation
 */

import { DIAGNOSTIC_TRUNCATE_LENGTH, MAX_DIAGNOSTIC_STRING_LENGTH } from './logger/logger_types.ts';

/**
 * Allow-list of diagnostic error fields safe to include in logs.
 * Secrets such as `apiKey`, `accessToken`, `Authorization`, and nested `response`/`config`
 * objects are excluded by omission rather than a denylist of exact key names.
 */
export const DIAGNOSTIC_ERROR_KEYS = new Set([
  'code',
  'status',
  'statuscode',
  'errno',
  'syscall',
  'errors',
  'reason',
]);

/**
 * Checks if a key matches one of the allow-listed diagnostic error fields.
 *
 * @param key - The property key to check.
 * @returns True if allow-listed.
 */
export function isDiagnosticErrorKey(key: string): boolean {
  return DIAGNOSTIC_ERROR_KEYS.has(key.toLowerCase());
}

function isAllowedDiagnosticField(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === 'name' || lower === 'message' || isDiagnosticErrorKey(key);
}

function appendDiagnosticEntry(
  target: Record<string, unknown>,
  key: string,
  val: unknown,
  visited: Set<unknown>,
): void {
  if (isAllowedDiagnosticField(key)) {
    target[key] = sanitizeDiagnosticValue(val, visited);
  }
}

function sanitizeObjectDiagnostics(
  rec: Record<string, unknown>,
  visited: Set<unknown>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    appendDiagnosticEntry(cleaned, k, v, visited);
  }
  return cleaned;
}

function sanitizePrimitiveDiagnostic(value: unknown): unknown {
  return typeof value === 'bigint' ? String(value) : value;
}

function sanitizeDiagnosticContainer(value: object, visited: Set<unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, visited));
  }
  return sanitizeObjectDiagnostics(value as Record<string, unknown>, visited);
}

function isNonObjectOrNull(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

function sanitizeVisitedDiagnostic(value: object, visited: Set<unknown>): unknown {
  if (visited.has(value)) {
    return '[Circular]';
  }
  visited.add(value);
  return sanitizeDiagnosticContainer(value, visited);
}

/**
 * Recursively copies only allow-listed diagnostic fields from nested error metadata.
 *
 * @param value - Value to sanitize.
 * @param visited - Set tracking visited references to prevent circular references.
 * @returns Sanitized diagnostic value.
 */
export function sanitizeDiagnosticValue(value: unknown, visited = new Set<unknown>()): unknown {
  if (isNonObjectOrNull(value)) {
    return sanitizePrimitiveDiagnostic(value);
  }
  return sanitizeVisitedDiagnostic(value as object, visited);
}

function truncateDiagnosticString(sanitized: string): string {
  if (sanitized.length > MAX_DIAGNOSTIC_STRING_LENGTH) {
    return `${sanitized.slice(0, DIAGNOSTIC_TRUNCATE_LENGTH)}...`;
  }
  return sanitized;
}

function formatDiagnosticObject(sanitized: object): string {
  try {
    const json = JSON.stringify(sanitized);
    return truncateDiagnosticString(json);
  } catch {
    return '[Object]';
  }
}

function isObjectEntity(val: unknown): val is object {
  return typeof val === 'object' && val !== null;
}

/**
 * Formats a diagnostic value as a concise, truncated string.
 *
 * @param value - Diagnostic value to format.
 * @returns Formatted and truncated diagnostic string.
 */
export function formatDiagnosticValue(value: unknown): string {
  const sanitized = sanitizeDiagnosticValue(value);
  if (typeof sanitized === 'string') {
    return truncateDiagnosticString(sanitized);
  }
  if (isObjectEntity(sanitized)) {
    return formatDiagnosticObject(sanitized);
  }
  return String(sanitized);
}
