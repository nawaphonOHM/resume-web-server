/**
 * Server Shutdown Completion Handlers.
 *
 * Manages post-close completion workflows, error logging, and process exit triggers.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { EXIT_CODE_ERROR, EXIT_CODE_SUCCESS } from '../server/server_constants.ts';
import { flushAndExit } from '../server/server_flush.ts';
import { logShutdownError, logShutdownSuccess } from './shutdown_telemetry.ts';
import type { ServerLogger } from '../server/server_types.ts';

/**
 * Execution context passed to shutdown completion handlers.
 */
export interface ShutdownExecutionContext {
  readonly timer?: NodeJS.Timeout;
  readonly requestInterceptor: (req: IncomingMessage, res: ServerResponse) => void;
  readonly logger: ServerLogger;
  readonly exitProcess: boolean;
  readonly onComplete?: () => void;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

/**
 * Parameters for building {@link ShutdownExecutionContext}.
 */
export interface ShutdownContextParams {
  readonly timer?: NodeJS.Timeout;
  readonly interceptor: (req: IncomingMessage, res: ServerResponse) => void;
  readonly logger: ServerLogger;
  readonly exitProcess: boolean;
  readonly onShutdownComplete?: () => void;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

export function createShutdownContext(p: ShutdownContextParams): ShutdownExecutionContext {
  const { timer, interceptor: requestInterceptor, logger, exitProcess } = p;
  const { onShutdownComplete: onComplete, resolve, reject } = p;
  return { timer, requestInterceptor, logger, exitProcess, onComplete, resolve, reject };
}

export function handleShutdownError(
  err: Error,
  ctx: Pick<ShutdownExecutionContext, 'logger' | 'exitProcess' | 'onComplete'>,
): void {
  logShutdownError(ctx.logger, err);
  ctx.onComplete?.();
  if (ctx.exitProcess) {
    void flushAndExit(EXIT_CODE_ERROR);
  }
}

export function handleShutdownSuccess(
  ctx: Pick<ShutdownExecutionContext, 'logger' | 'exitProcess' | 'onComplete'>,
): void {
  logShutdownSuccess(ctx.logger);
  ctx.onComplete?.();
  if (ctx.exitProcess) {
    void flushAndExit(EXIT_CODE_SUCCESS);
  }
}

function processCloseResult(err: Error | undefined, ctx: ShutdownExecutionContext): void {
  if (err) {
    handleShutdownError(err, ctx);
    ctx.reject(err);
    return;
  }
  handleShutdownSuccess(ctx);
  ctx.resolve();
}

export function performServerClose(server: Server, ctx: ShutdownExecutionContext): void {
  server.close((err) => {
    server.off('request', ctx.requestInterceptor);
    if (ctx.timer) {
      clearTimeout(ctx.timer);
    }
    processCloseResult(err, ctx);
  });
}
