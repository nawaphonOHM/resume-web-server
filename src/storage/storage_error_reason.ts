/**
 * Storage error reason resolution and formatting helpers.
 *
 * @packageDocumentation
 */

import { HTTP_STATUS_NOT_FOUND } from '../http/http_status_codes.ts';
import type { LogLevel } from '../logger/logger_types.ts';

export function resolveMidStreamReason(isHead: boolean | undefined, status: number): string {
  const kind = isHead ? 'metadata' : 'read stream';
  return `Storage ${kind} error occurred after HTTP response headers were already sent with status ${String(status)}`;
}

function formatNotFoundReason(notFoundStatusCode: number): string {
  if (notFoundStatusCode === HTTP_STATUS_NOT_FOUND) {
    return 'GCS error indicated object not found, not missing bucket';
  }
  return `GCS error indicated object not found, mapped to ${String(notFoundStatusCode)} by caller (missing SPA index.html fallback)`;
}

export function formatErrorReason(is404: boolean, notFoundStatusCode: number): string {
  if (!is404) {
    return 'GCS error indicates bucket missing or storage backend failure';
  }
  return formatNotFoundReason(notFoundStatusCode);
}

export function resolveStandardChoice(statusCode: number): string {
  if (statusCode === HTTP_STATUS_NOT_FOUND) return '404 Not Found';
  return `${String(statusCode)} Bad Gateway`;
}

function isDebugNotFound(is404: boolean, notFoundStatusCode: number): boolean {
  return is404 && notFoundStatusCode === HTTP_STATUS_NOT_FOUND;
}

export function resolveErrorLevel(is404: boolean, notFoundStatusCode: number): LogLevel {
  return isDebugNotFound(is404, notFoundStatusCode) ? 'debug' : 'warn';
}

export function withDefault<T>(value: T | undefined, fallback: T): T {
  return value ?? fallback;
}
