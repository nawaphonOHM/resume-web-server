/**
 * Validation and error notification for required configuration variables.
 *
 * @packageDocumentation
 */

import type { AppLogger } from '../logger/logger.ts';
import { EXIT_CODE_ERROR } from './config_types.ts';

function notifyError(
  msg: string,
  logger?: AppLogger,
  exitFn?: (code: number, msg: string) => void,
): void {
  if (logger) logger.error(msg);
  if (exitFn) exitFn(EXIT_CODE_ERROR, msg);
}

function buildMissingMessage(missingVars: readonly string[]): string {
  const list = missingVars.join(', ');
  return `Missing required environment variable(s): ${list}. Please set ${missingVars.join(' and ')} before running the server.`;
}

/**
 * Asserts that all required configuration environment variables are defined and non-empty.
 *
 * @param missingVars - List of missing variable names.
 * @param logger - Optional application logger for recording errors.
 * @param exitFn - Optional process exit handler.
 */
export function assertRequiredVariables(
  missingVars: readonly string[],
  logger?: AppLogger,
  exitFn?: (code: number, msg: string) => void,
): void {
  if (missingVars.length === 0) return;
  const msg = buildMissingMessage(missingVars);
  notifyError(msg, logger, exitFn);
  throw new Error(msg);
}
