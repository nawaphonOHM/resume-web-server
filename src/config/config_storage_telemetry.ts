/**
 * Structured telemetry logging for storage configuration decisions.
 *
 * @packageDocumentation
 */

import type { AppLogger } from '../logger/logger.ts';
import { emitDecision, type DecisionInfo } from './config_telemetry.ts';

function makeBucketDecision(bucket: string): DecisionInfo {
  return {
    choice: `bucketName: '${bucket}'`,
    reason: 'Resolved from GCS_BUCKET_NAME environment variable',
    variable: 'GCS_BUCKET_NAME',
    resolved: bucket,
  };
}

/**
 * Logs the decision payload for resolving the `GCS_BUCKET_NAME` configuration parameter.
 *
 * @param logger - Optional application logger.
 * @param bucket - Resolved bucket name.
 */
export function logBucketDecision(logger: AppLogger | undefined, bucket: string): void {
  if (logger) emitDecision(logger, makeBucketDecision(bucket));
}

function makePrefixDecision(prefix: string): DecisionInfo {
  return {
    choice: `prefix: '${prefix}'`,
    reason: 'Resolved from GCS_PREFIX environment variable and normalized',
    variable: 'GCS_PREFIX',
    resolved: prefix,
  };
}

/**
 * Logs the decision payload for resolving the `GCS_PREFIX` configuration parameter.
 *
 * @param logger - Optional application logger.
 * @param prefix - Resolved and normalized prefix.
 */
export function logPrefixDecision(logger: AppLogger | undefined, prefix: string): void {
  if (logger) emitDecision(logger, makePrefixDecision(prefix));
}
