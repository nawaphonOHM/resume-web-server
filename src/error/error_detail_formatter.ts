/**
 * Error detail formatting utilities.
 *
 * @packageDocumentation
 */

import { formatDiagnosticValue, isDiagnosticErrorKey } from '../diagnostic_sanitizer.ts';
import { sanitizeErrorMessage } from './error_message_sanitizer.ts';

function formatDiagnosticEntries(obj: Record<string, unknown>): string {
  const extraEntries = Object.entries(obj).filter(([key]) => isDiagnosticErrorKey(key));
  if (extraEntries.length === 0) {
    return '';
  }
  return extraEntries.map(([k, v]) => `${k}: ${formatDiagnosticValue(v)}`).join(', ');
}

function assembleDetailString(name: string, message: string, extra: string): string {
  return extra.length > 0 ? `${name}: ${message} (${extra})` : `${name}: ${message}`;
}

function formatObjectErrorDetail(obj: Record<string, unknown>, raw: unknown): string {
  const name = typeof obj['name'] === 'string' ? obj['name'] : 'Error';
  const message = typeof obj['message'] === 'string' ? obj['message'] : sanitizeErrorMessage(raw);
  return assembleDetailString(name, message, formatDiagnosticEntries(obj));
}

function isObjectErrorCandidate(err: unknown): err is object {
  return err instanceof Error || (typeof err === 'object' && err !== null);
}

/**
 * Formats the summary line of an error including diagnostic properties (e.g. `ErrorName: error message (code: 503)`).
 * Bounded to prevent sensitive credentials or bulky socket/response objects from leaking.
 *
 * @param err - The error object, string, or unknown value.
 * @returns Concise error detail string.
 */
export function formatErrorDetail(err: unknown): string {
  if (isObjectErrorCandidate(err)) {
    return formatObjectErrorDetail(err as Record<string, unknown>, err);
  }
  return typeof err === 'string' ? `Error: ${err}` : `Error: ${sanitizeErrorMessage(err)}`;
}
