/**
 * Java-style stack trace formatter with nested cause chain support.
 *
 * @packageDocumentation
 */

import { escapeForConsole } from '../console/console_sanitizer.ts';
import { sanitizeErrorMessage } from '../error/error_message_sanitizer.ts';
import {
  assembleTraceHeader,
  extractRawErrorInfo,
  isObjectRecord,
} from '../stack/stack_frame_extractor.ts';

function extractMessageProperty(err: Record<string, unknown>): string | undefined {
  const msg = err['message'];
  return typeof msg === 'string' ? msg : undefined;
}

function extractCircularText(err: unknown): string {
  if (isObjectRecord(err)) {
    return extractMessageProperty(err) ?? sanitizeErrorMessage(err);
  }
  return sanitizeErrorMessage(err);
}

function formatCircularMessage(err: unknown): string {
  return `[Circular: ${escapeForConsole(extractCircularText(err))}]`;
}

function formatCauseTrace(cause: unknown, visited: Set<unknown>): string {
  if (visited.has(cause)) {
    return `\nCaused by: ${formatCircularMessage(cause)}`;
  }
  return `\nCaused by: ${formatJavaStyleStackTrace(cause, visited)}`;
}

function extractCause(err: unknown): unknown {
  if (isObjectRecord(err) && 'cause' in err) {
    return err['cause'];
  }
  return undefined;
}

function appendCauseChain(trace: string, err: unknown, visited: Set<unknown>): string {
  const cause = extractCause(err);
  if (cause === undefined || cause === null) {
    return trace;
  }
  return trace + formatCauseTrace(cause, visited);
}

function buildStackTraceString(err: unknown, visited: Set<unknown>): string {
  visited.add(err);
  const info = extractRawErrorInfo(err);
  const trace = assembleTraceHeader(info);
  return appendCauseChain(trace, err, visited);
}

function isNullOrUndefined(val: unknown): boolean {
  return val === null || val === undefined;
}

function checkEarlyStackTraceReturn(err: unknown, visited: Set<unknown>): string | undefined {
  if (isNullOrUndefined(err)) {
    return 'Error: Unknown error';
  }
  return visited.has(err) ? formatCircularMessage(err) : undefined;
}

/**
 * Recursively formats an error and its nested cause chain (ES2022 `Error.cause`) in Java-style stack trace format.
 * Includes loop detection for circular error causes.
 *
 * @param err - The error object, string, or unknown value to format.
 * @param visited - Set tracking visited error instances to prevent infinite loops on circular causes.
 * @returns Complete Java-style stack trace string with `Caused by:` prefixes for nested causes.
 */
export function formatJavaStyleStackTrace(err: unknown, visited = new Set<unknown>()): string {
  const early = checkEarlyStackTraceReturn(err, visited);
  if (early !== undefined) {
    return early;
  }
  return buildStackTraceString(err, visited);
}
