/**
 * HTTP server incoming request routing and in-flight shutdown handler.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Socket } from 'node:net';
import { defaultLogger } from '../default_logger.ts';
import type { AppLogger } from '../logger/logger_types.ts';
import { write500InternalServerError } from '../router/router_error_responder.ts';
import { logUnhandledRouterError } from '../router/router_telemetry.ts';
import type { IShutdownManager } from './server_types.ts';

function handleShutdownHeaders(res: ServerResponse, isShuttingDown: boolean): void {
  if (isShuttingDown && !res.headersSent) {
    res.setHeader('Connection', 'close');
  }
}

function shouldDestroySocket(socket: Socket, res: ServerResponse): boolean {
  return !socket.destroyed && !res.writableEnded;
}

function attachFinishGuard(res: ServerResponse, socket: Socket, isStopping: () => boolean): void {
  res.on('finish', () => {
    if (isStopping() && !socket.destroyed) {
      socket.end();
    }
  });
}

function attachCloseGuard(res: ServerResponse, socket: Socket, isStopping: () => boolean): void {
  res.on('close', () => {
    if (isStopping() && shouldDestroySocket(socket, res)) {
      socket.destroy();
    }
  });
}

function attachShutdownGuards(
  res: ServerResponse,
  socket: Socket,
  isStopping: () => boolean,
): void {
  attachFinishGuard(res, socket, isStopping);
  attachCloseGuard(res, socket, isStopping);
}

function tryLogRouterError(logger: AppLogger, req: IncomingMessage, err: unknown): void {
  try {
    logUnhandledRouterError(logger, req, err);
  } catch {
    // Best-effort logging; ignore logger failures
  }
}

function handleRouterError(
  logger: AppLogger,
  req: IncomingMessage,
  res: ServerResponse,
  err: unknown,
): void {
  tryLogRouterError(logger, req, err);
  write500InternalServerError(res);
}

function dispatchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  router: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  logger: AppLogger,
): void {
  router(req, res).catch((err: unknown) => {
    handleRouterError(logger, req, res, err);
  });
}

type HttpRouter = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

function handleIncoming(res: ServerResponse, socket: Socket, isStopping: () => boolean): void {
  handleShutdownHeaders(res, isStopping());
  attachShutdownGuards(res, socket, isStopping);
}

function makeDispatcher(
  router: HttpRouter,
  isStopping: () => boolean,
  logger: AppLogger,
): HttpHandler {
  return (req, res): void => {
    handleIncoming(res, req.socket, isStopping);
    dispatchRequest(req, res, router, logger);
  };
}

/**
 * Creates an HTTP request listener that delegates to the router and handles shutdown headers.
 *
 * @param router - Async routing function handling incoming requests.
 * @param shutdownManager - Manager tracking server shutdown state.
 * @param server - HTTP server instance.
 * @param logger - Optional application logger for error recording (defaults to {@link defaultLogger}).
 */
export function createHttpRequestHandler(
  router: HttpRouter,
  shutdownManager: IShutdownManager,
  server: Server,
  logger: AppLogger = defaultLogger,
): HttpHandler {
  const isStopping = () => shutdownManager.isShuttingDown(server);
  return makeDispatcher(router, isStopping, logger);
}
