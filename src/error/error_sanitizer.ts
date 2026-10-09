/**
 * Error serialization and sanitization utilities.
 *
 * @packageDocumentation
 */

import { isDiagnosticErrorKey, sanitizeDiagnosticValue } from '../diagnostic_sanitizer.ts';
import { sanitizeErrorMessage } from './error_message_sanitizer.ts';

function extractErrorName(obj: Record<string, unknown>): string {
  return typeof obj['name'] === 'string' ? obj['name'] : 'Error';
}

function extractErrorMessage(obj: Record<string, unknown>, raw: unknown): string {
  return typeof obj['message'] === 'string' ? obj['message'] : sanitizeErrorMessage(raw);
}

function copyFieldIfDiagnostic(
  target: Record<string, unknown>,
  k: string,
  v: unknown,
  visited: Set<unknown>,
): void {
  if (isDiagnosticErrorKey(k)) {
    target[k] = sanitizeDiagnosticValue(v, visited);
  }
}

function copyDiagnosticFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  visited: Set<unknown>,
): void {
  for (const [k, v] of Object.entries(source)) {
    copyFieldIfDiagnostic(target, k, v, visited);
  }
}

function buildErrorObjectSummary(
  errorObj: Record<string, unknown>,
  visited: Set<unknown>,
): Record<string, unknown> {
  const name = extractErrorName(errorObj);
  const message = extractErrorMessage(errorObj, errorObj);
  const summary: Record<string, unknown> = { name, message };
  copyDiagnosticFields(errorObj, summary, visited);
  return summary;
}

function isNullish(val: unknown): boolean {
  return val === null || val === undefined;
}

function extractPrimitiveMessage(err: unknown): string {
  if (isNullish(err)) {
    return 'Unknown error';
  }
  return typeof err === 'string' ? err : sanitizeErrorMessage(err);
}

function sanitizePrimitiveErrorForLog(err: unknown): Record<string, unknown> {
  return { name: 'Error', message: extractPrimitiveMessage(err) };
}

function sanitizeVisitedErrorForLog(err: object, visited: Set<unknown>): Record<string, unknown> {
  if (visited.has(err)) {
    return { name: 'Error', message: '[Circular]' };
  }
  visited.add(err);
  return buildErrorObjectSummary(err as Record<string, unknown>, visited);
}

function isNonObjectOrNull(err: unknown): boolean {
  return typeof err !== 'object' || err === null;
}

/**
 * Replaces a raw Error (or error-like value) with a sanitized summary that is safe to serialize.
 * Retains only `name`, `message`, and allow-listed diagnostic fields.
 *
 * @param err - Unknown error or object.
 * @param visited - Set tracking visited objects.
 * @returns Sanitized error object summary.
 */
export function sanitizeErrorForLog(
  err: unknown,
  visited = new Set<unknown>(),
): Record<string, unknown> {
  if (isNonObjectOrNull(err)) {
    return sanitizePrimitiveErrorForLog(err);
  }
  return sanitizeVisitedErrorForLog(err as object, visited);
}
