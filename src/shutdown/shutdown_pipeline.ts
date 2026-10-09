/**
 * Server Shutdown Pipeline and Execution Module.
 *
 * Coordinates graceful HTTP server connection draining, idle socket termination,
 * fallback timeout destruction, and process exit handlers.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { logger as defaultLogger } from '../logger/logger.ts';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../server/server_constants.ts';
import {
  createShutdownContext,
  performServerClose,
  type ShutdownContextParams,
} from './shutdown_completion.ts';
import {
  closeIdleConnectionsIfSupported,
  createShutdownRequestInterceptor,
} from './shutdown_interceptor.ts';
import { logShutdownStart } from './shutdown_telemetry.ts';
import { scheduleShutdownTimer } from './shutdown_timer.ts';
import type { ServerLogger, ShutdownOptions } from '../server/server_types.ts';

interface ResolvedShutdownOptions {
  readonly logger: ServerLogger;
  readonly timeoutMs: number;
  readonly exitProcess: boolean;
  readonly sockets?: Set<Socket> | ReadonlySet<Socket>;
  readonly onShutdownComplete?: () => void;
}

function resolveShutdownOptions(options: ShutdownOptions): ResolvedShutdownOptions {
  return {
    logger: options.logger ?? defaultLogger,
    timeoutMs: options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    exitProcess: Boolean(options.exitProcess),
    sockets: options.sockets,
    onShutdownComplete: options.onShutdownComplete,
  };
}

function initShutdownTimer(
  server: Server,
  opts: ResolvedShutdownOptions,
): NodeJS.Timeout | undefined {
  const { sockets, logger, timeoutMs } = opts;
  return scheduleShutdownTimer({ server, sockets, logger, timeoutMs });
}

function initShutdownInterceptor(
  server: Server,
): (req: IncomingMessage, res: ServerResponse) => void {
  const interceptor = createShutdownRequestInterceptor();
  server.on('request', interceptor);
  return interceptor;
}

function makeShutdownContextParams(
  timer: NodeJS.Timeout | undefined,
  interceptor: (req: IncomingMessage, res: ServerResponse) => void,
  opts: ResolvedShutdownOptions,
  settle: { resolve: () => void; reject: (err: Error) => void },
): ShutdownContextParams {
  const { logger, exitProcess, onShutdownComplete } = opts;
  const { resolve, reject } = settle;
  return { timer, interceptor, logger, exitProcess, onShutdownComplete, resolve, reject };
}

interface PipelineArgs {
  readonly server: Server;
  readonly opts: ResolvedShutdownOptions;
  readonly settle: { resolve: () => void; reject: (err: Error) => void };
}

function setupShutdownPipeline(args: PipelineArgs): void {
  const { server, opts, settle } = args;
  const timer = initShutdownTimer(server, opts);
  closeIdleConnectionsIfSupported(server, opts.logger);
  const interceptor = initShutdownInterceptor(server);
  const params = makeShutdownContextParams(timer, interceptor, opts, settle);
  performServerClose(server, createShutdownContext(params));
}

/**
 * Executes a graceful shutdown pipeline for an HTTP server instance.
 *
 * @param server - The Node.js HTTP server instance to shut down.
 * @param options - Shutdown options.
 * @returns Promise that resolves on successful shutdown.
 */
export function executeShutdown(server: Server, options: ShutdownOptions): Promise<void> {
  const opts = resolveShutdownOptions(options);
  logShutdownStart(opts.logger, opts.timeoutMs, opts.exitProcess, opts.sockets);
  return new Promise<void>((resolve, reject) => {
    setupShutdownPipeline({ server, opts, settle: { resolve, reject } });
  });
}
