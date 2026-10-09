/**
 * Server Shutdown Decision Telemetry.
 *
 * Provides structured decision logging helpers for the graceful shutdown lifecycle.
 *
 * @packageDocumentation
 */

import type { Socket } from 'node:net';
import { logDecision, type DecisionLogPayload } from '../logger/logger.ts';
import type { ServerLogger } from '../server/server_types.ts';

const SHUTDOWN_START_BASE: DecisionLogPayload = {
  action: 'ServerShutdown',
  choice: 'initiate graceful shutdown',
  reason: 'Closing HTTP server and draining in-flight connections',
  level: 'info',
};

function createShutdownStartPayload(
  timeoutMs: number,
  exitProcess: boolean,
  sockets?: Set<Socket> | ReadonlySet<Socket>,
): DecisionLogPayload {
  const trackedSockets = sockets?.size ?? 0;
  return { ...SHUTDOWN_START_BASE, timeoutMs, exitProcess, trackedSockets };
}

/**
 * Logs the initial shutdown initiation decision.
 */
export function logShutdownStart(
  logger: ServerLogger,
  timeoutMs: number,
  exitProcess: boolean,
  sockets?: Set<Socket> | ReadonlySet<Socket>,
): void {
  logDecision(logger, createShutdownStartPayload(timeoutMs, exitProcess, sockets));
}

function makeTimeoutBase(timeoutMs: number): DecisionLogPayload {
  return {
    action: 'ServerShutdown',
    choice: 'force-destroy remaining connections',
    reason: `Shutdown timeout reached (${String(timeoutMs)}ms) before all connections drained`,
    level: 'warn',
  };
}

function createShutdownTimeoutPayload(
  timeoutMs: number,
  sockets?: Set<Socket> | ReadonlySet<Socket>,
): DecisionLogPayload {
  const remainingSockets = sockets?.size ?? 'unknown';
  return { ...makeTimeoutBase(timeoutMs), remainingSockets, timeoutMs };
}

/**
 * Logs force socket destruction decision on shutdown deadline timeout.
 */
export function logShutdownTimeout(
  logger: ServerLogger,
  timeoutMs: number,
  sockets?: Set<Socket> | ReadonlySet<Socket>,
): void {
  logDecision(logger, createShutdownTimeoutPayload(timeoutMs, sockets));
}

/**
 * Logs server close error decision.
 */
export function logShutdownError(logger: ServerLogger, err: Error): void {
  logDecision(logger, {
    action: 'ServerShutdown',
    choice: 'shutdown failure',
    reason: `Server failed to close cleanly: ${err.message}`,
    level: 'error',
    error: err,
  });
}

/**
 * Logs server close success decision.
 */
export function logShutdownSuccess(logger: ServerLogger): void {
  logDecision(logger, {
    action: 'ServerShutdown',
    choice: 'shutdown complete',
    reason: 'All active connections drained and server closed successfully',
    level: 'info',
  });
}
