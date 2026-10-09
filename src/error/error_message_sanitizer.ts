/**
 * Error message sanitization utilities.
 *
 * @packageDocumentation
 */

import { sanitizeDiagnosticValue } from '../diagnostic_sanitizer.ts';

function stringifyError(err: Error): string {
  return err.message.length > 0 ? err.message : err.name;
}

function isStringOrBigInt(err: unknown): boolean {
  return typeof err === 'string' || typeof err === 'bigint';
}

function isNumberOrBool(err: unknown): boolean {
  return typeof err === 'number' || typeof err === 'boolean';
}

function isScalar(err: unknown): boolean {
  if (isStringOrBigInt(err)) return true;
  return isNumberOrBool(err);
}

function isNonNullObject(err: unknown): err is object {
  return typeof err === 'object' && err !== null;
}

function formatPrimitive(err: unknown): string {
  if (typeof err === 'symbol') {
    return err.toString();
  }
  return err === undefined ? 'undefined' : 'null';
}

function tryFormatDiagnosticObject(obj: Record<string, unknown>): string | undefined {
  const diag = sanitizeDiagnosticValue(obj) as Record<string, unknown>;
  try {
    return Object.keys(diag).length > 0 ? JSON.stringify(diag) : undefined;
  } catch {
    return undefined;
  }
}

function formatObjectFallback(obj: Record<string, unknown>): string {
  const ownKeys = Object.keys(obj);
  return ownKeys.length > 0 ? `[object with keys: ${ownKeys.join(', ')}]` : '[Object]';
}

function extractObjectMessage(obj: Record<string, unknown>): string | undefined {
  const msg = obj['message'];
  return typeof msg === 'string' && msg.length > 0 ? msg : undefined;
}

function resolveObjectRepresentation(obj: Record<string, unknown>): string {
  const formattedDiag = tryFormatDiagnosticObject(obj);
  if (formattedDiag !== undefined) {
    return formattedDiag;
  }
  return formatObjectFallback(obj);
}

function sanitizeVisitedObject(obj: Record<string, unknown>, visited: Set<unknown>): string {
  visited.add(obj);
  const msg = extractObjectMessage(obj);
  return msg ?? resolveObjectRepresentation(obj);
}

function sanitizeObjectError(obj: Record<string, unknown>, visited: Set<unknown>): string {
  if (visited.has(obj)) {
    return '[Circular]';
  }
  return sanitizeVisitedObject(obj, visited);
}

function sanitizeErrorCandidate(err: unknown, visited: Set<unknown>): string {
  if (err instanceof Error) {
    return stringifyError(err);
  }
  return sanitizeObjectError(err as Record<string, unknown>, visited);
}

function formatScalar(err: unknown): string {
  return typeof err === 'string' ? err : String(err);
}

function sanitizeNonNullObject(err: object, visited?: Set<unknown>): string {
  return sanitizeErrorCandidate(err, visited ?? new Set<unknown>());
}

/**
 * Safely extracts a concise, sanitized message from an unknown error or object without dumping sensitive contents.
 *
 * @param err - Unknown error or object.
 * @param visited - Set tracking visited objects to prevent circular loops.
 * @returns Safe string message.
 */
export function sanitizeErrorMessage(err: unknown, visited?: Set<unknown>): string {
  if (isScalar(err)) {
    return formatScalar(err);
  }
  if (isNonNullObject(err)) {
    return sanitizeNonNullObject(err, visited);
  }
  return formatPrimitive(err);
}
