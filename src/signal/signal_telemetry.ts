/**
 * Process Signal Decision Telemetry.
 *
 * Provides structured decision logging helpers for OS signal handling.
 *
 * @packageDocumentation
 */

import { logDecision, type DecisionLogPayload } from '../logger/logger.ts';
import type { ServerLogger } from '../server/server_types.ts';

/**
 * Logs decision when a duplicate signal is received while shutdown is already in progress.
 */
export function logDuplicateSignal(logger: ServerLogger, signal: string): void {
  logDecision(logger, {
    action: 'ProcessSignal',
    choice: `ignore duplicate ${signal}`,
    reason: 'Graceful shutdown is already in progress',
    level: 'info',
    signal,
  });
}

/**
 * Logs decision when handling a received OS process signal.
 */
export function logHandleSignal(
  logger: ServerLogger,
  signal: string,
  opts: { timeoutMs: number; exitProcess: boolean },
): void {
  const { timeoutMs, exitProcess } = opts;
  logDecision(logger, { ...makeHandleSignalBase(signal), signal, timeoutMs, exitProcess });
}

function makeHandleSignalBase(signal: string): DecisionLogPayload {
  return {
    action: 'ProcessSignal',
    choice: `handle ${signal}`,
    reason: `OS signal ${signal} received, triggering graceful shutdown workflow`,
    level: 'info',
  };
}
