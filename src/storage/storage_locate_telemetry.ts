/**
 * Structured telemetry decision logging for storage object locator operations.
 *
 * @packageDocumentation
 */

import type { AppLogger, DecisionLogPayload } from '../logger/logger_types.ts';
import type { LocateResult } from './storage_types.ts';

export interface StorageLocateDecisionInfo {
  readonly objectName: string;
  readonly prefix: string;
  readonly result: LocateResult | null;
}

function buildLocateChoice(result: LocateResult | null): string {
  if (!result) return 'not found';
  return `${result.strategy}: ${result.fullPath}`;
}

function buildFoundReason(name: string, result: LocateResult): string {
  if (result.strategy === 'direct') {
    return `Object '${name}' resolved directly at '${result.fullPath}'`;
  }
  const tsSuffix = result.unixtime !== undefined ? ` (timestamp: ${String(result.unixtime)})` : '';
  return `Object '${name}' resolved recursively to newest deployment at '${result.fullPath}'${tsSuffix}`;
}

function buildLocateReason(name: string, prefix: string, result: LocateResult | null): string {
  if (!result) {
    return `Object '${name}' not found directly or recursively under prefix '${prefix}'`;
  }
  return buildFoundReason(name, result);
}

function buildMetaFields(result: LocateResult | null): {
  fullPath?: string;
  strategy: string;
  unixtime?: number;
} {
  if (!result) return { strategy: 'none' };
  return { fullPath: result.fullPath, strategy: result.strategy, unixtime: result.unixtime };
}

function buildLocateHeader(info: StorageLocateDecisionInfo): DecisionLogPayload {
  return {
    action: 'StorageLocator',
    choice: buildLocateChoice(info.result),
    reason: buildLocateReason(info.objectName, info.prefix, info.result),
    level: 'debug',
  };
}

function buildLocatePayload(info: StorageLocateDecisionInfo): DecisionLogPayload {
  return {
    ...buildLocateHeader(info),
    objectName: info.objectName,
    prefix: info.prefix,
    ...buildMetaFields(info.result),
  };
}

/**
 * Emits a structured telemetry decision log for an object locating attempt.
 *
 * @param logger - Injected application logger.
 * @param info - Locating context and result.
 */
export function logStorageLocateDecision(
  logger: AppLogger | undefined,
  info: StorageLocateDecisionInfo,
): void {
  if (!logger) return;
  logger.decision(buildLocatePayload(info));
}
