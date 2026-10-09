/**
 * GCS error classifier distinguishing 404 Object Not Found from bucket/network errors.
 *
 * @packageDocumentation
 */

import { HTTP_STATUS_NOT_FOUND } from '../http/http_status_codes.ts';
import type { IStorageErrorClassifier } from './storage_types.ts';

const BUCKET_PATTERNS = ['specified bucket', 'nosuchbucket', 'no such bucket'];
const BUCKET_QUALIFIERS = [
  'not found',
  'not exist',
  'does not exist',
  'unknown',
  'invalid',
  'missing',
];

function matchesDirectBucket(lower: string): boolean {
  return BUCKET_PATTERNS.some((pattern) => lower.includes(pattern));
}

function matchesBucketQualifier(lower: string): boolean {
  return lower.includes('bucket') && BUCKET_QUALIFIERS.some((q) => lower.includes(q));
}

function isMissingBucketMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return matchesDirectBucket(lower) || matchesBucketQualifier(lower);
}

function extractSubErrors(errObj: Record<string, unknown>): Record<string, unknown>[] {
  const errors = errObj['errors'];
  return Array.isArray(errors) ? (errors as Record<string, unknown>[]) : [];
}

function hasMissingBucketInErrors(errors: Record<string, unknown>[]): boolean {
  return errors.some((sub) => {
    const msg = typeof sub['message'] === 'string' ? sub['message'] : '';
    return isMissingBucketMessage(msg);
  });
}

function extractStatusCode(errObj: Record<string, unknown>): unknown {
  return errObj['code'] ?? errObj['statusCode'] ?? errObj['status'];
}

function isStatus404(errObj: Record<string, unknown>): boolean {
  const code = extractStatusCode(errObj);
  return code === HTTP_STATUS_NOT_FOUND || code === '404';
}

function hasNotFoundReason(errors: Record<string, unknown>[]): boolean {
  return errors.some((sub) => {
    const msg = typeof sub['message'] === 'string' ? sub['message'].toLowerCase() : '';
    return sub['reason'] === 'notFound' || msg.includes('not found');
  });
}

function isNotFoundSignal(lowerMsg: string, errors: Record<string, unknown>[]): boolean {
  return lowerMsg.includes('not found') || hasNotFoundReason(errors);
}

function hasBucketError(msg: string, errors: Record<string, unknown>[]): boolean {
  return isMissingBucketMessage(msg) || hasMissingBucketInErrors(errors);
}

function checkBucketAndStatus(
  errObj: Record<string, unknown>,
  msg: string,
  errors: Record<string, unknown>[],
): boolean | null {
  if (hasBucketError(msg, errors)) {
    return false;
  }
  return isStatus404(errObj) ? true : null;
}

function hasNoSuchObject(lower: string): boolean {
  return lower.includes('no such object');
}

function evaluateErrorStatus(errObj: Record<string, unknown>, msg: string, lower: string): boolean {
  const errors = extractSubErrors(errObj);
  const statusCheck = checkBucketAndStatus(errObj, msg, errors);
  return statusCheck ?? isNotFoundSignal(lower, errors);
}

function inspectErrorObject(errObj: Record<string, unknown>): boolean {
  const msg = typeof errObj['message'] === 'string' ? errObj['message'] : '';
  const lower = msg.toLowerCase();
  if (hasNoSuchObject(lower)) {
    return true;
  }
  return evaluateErrorStatus(errObj, msg, lower);
}

/**
 * GCS error classifier evaluating whether an exception represents a 404 missing object error (Single Responsibility Principle).
 */
export class GcsErrorClassifier implements IStorageErrorClassifier {
  /**
   * Determines whether an error thrown by the GCS client represents a 404 Object Not Found condition.
   *
   * @param err - The caught error value to evaluate.
   * @returns `true` if the error specifically represents an object not found condition; otherwise `false`.
   */
  public isNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') {
      return false;
    }
    return inspectErrorObject(err as Record<string, unknown>);
  }
}

/**
 * Default singleton helper instance.
 */
export const defaultErrorClassifier: IStorageErrorClassifier = new GcsErrorClassifier();

/**
 * Determines whether an error thrown by the GCS client represents a 404 Object Not Found condition.
 *
 * @remarks
 * Evaluates the caught error against the following decision procedure:
 * 1. Returns `true` if the top-level error message explicitly contains `'no such object'`.
 * 2. Returns `false` if the top-level message or any nested `errors[]` entry indicates a missing/invalid bucket.
 * 3. Returns `true` if `code`, `statusCode`, or `status` is `404` (or string `'404'`).
 * 4. Returns `true` if the top-level error message contains `'not found'`.
 * 5. Returns `true` if any nested `errors[]` entry has `reason === 'notFound'` or a message containing `'not found'`.
 * 6. Returns `false` otherwise.
 *
 * @param err - The caught error value to evaluate.
 * @returns `true` if the error specifically represents an object not found condition; otherwise `false`.
 *
 * @example
 * ```ts
 * try {
 *   await file.exists();
 * } catch (err) {
 *   if (isNotFoundError(err)) {
 *     // Object 404 handled cleanly
 *   }
 * }
 * ```
 */
export function isNotFoundError(err: unknown): boolean {
  return defaultErrorClassifier.isNotFoundError(err);
}
