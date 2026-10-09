/**
 * Server Shutdown Timer Module.
 *
 * Schedules fallback timeout timers to force-close active connections if
 * request draining exceeds the shutdown deadline.
 *
 * @packageDocumentation
 */

import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { forceCloseConnections } from './shutdown_interceptor.ts';
import { logShutdownTimeout } from './shutdown_telemetry.ts';
import type { ServerLogger } from '../server/server_types.ts';

function onShutdownTimeout(
  server: Server,
  sockets: Set<Socket> | ReadonlySet<Socket> | undefined,
  logger: ServerLogger,
  timeoutMs: number,
): void {
  logShutdownTimeout(logger, timeoutMs, sockets);
  forceCloseConnections(server, sockets);
}

function createTimeoutTimer(onTimeout: () => void, timeoutMs: number): NodeJS.Timeout {
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref();
  return timer;
}

export interface ShutdownTimerOptions {
  readonly server: Server;
  readonly sockets?: Set<Socket> | ReadonlySet<Socket>;
  readonly logger: ServerLogger;
  readonly timeoutMs: number;
}

/**
 * Schedules an unreferenced timer to force connection teardown upon timeout.
 */
export function scheduleShutdownTimer(opts: ShutdownTimerOptions): NodeJS.Timeout | undefined {
  if (opts.timeoutMs <= 0) {
    return undefined;
  }
  return createTimeoutTimer(() => {
    onShutdownTimeout(opts.server, opts.sockets, opts.logger, opts.timeoutMs);
  }, opts.timeoutMs);
}
