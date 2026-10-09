/**
 * Telemetry decision logger for storage streaming operations.
 *
 * @packageDocumentation
 */

import type { AppLogger } from '../logger/logger_types.ts';

export {
  type StorageLocateDecisionInfo,
  logStorageLocateDecision,
} from './storage_locate_telemetry.ts';

export interface StorageStreamDecisionInfo {
  readonly objectName: string;
  readonly fullPath: string;
  readonly contentType: string;
  readonly isHashedAsset: boolean;
  readonly isHeadRequest: boolean;
  readonly notFoundStatusCode: number;
}

function getStreamChoice(isHead: boolean): string {
  return isHead ? 'HEAD metadata inspection' : 'GET byte streaming';
}

function getStreamReason(isHead: boolean): string {
  if (isHead)
    return 'Request method is HEAD, inspecting GCS metadata without streaming response body';
  return 'Request method is GET, streaming file payload from GCS to HTTP response';
}

export function logStorageStreamDecision(logger: AppLogger, info: StorageStreamDecisionInfo): void {
  const isHead = info.isHeadRequest;
  logger.decision({
    action: 'StorageStream',
    choice: getStreamChoice(isHead),
    reason: getStreamReason(isHead),
    level: 'debug',
    ...info,
  });
}
