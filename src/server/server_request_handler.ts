/**
 * HTTP server incoming request routing and in-flight shutdown handler.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Socket } from 'node:net';
import { HTTP_STATUS_INTERNAL_SERVER_ERROR } from '../http/http_status_codes.ts';
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

function isResponseWritable(res: ServerResponse): boolean {
  return !res.headersSent && !res.destroyed && !res.writableEnded;
}

function handleRouterError(res: ServerResponse): void {
  if (isResponseWritable(res)) {
    res.statusCode = HTTP_STATUS_INTERNAL_SERVER_ERROR;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end('Internal Server Error');
  }
}

function dispatchRequest(
  req: IncomingMessage,
  res: ServerResponse,
  router: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): void {
  router(req, res).catch(() => {
    handleRouterError(res);
  });
}

function handleIncomingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  isStopping: () => boolean,
  router: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): void {
  handleShutdownHeaders(res, isStopping());
  attachShutdownGuards(res, req.socket, isStopping);
  dispatchRequest(req, res, router);
}

/**
 * Creates an HTTP request listener that delegates to the router and handles shutdown headers.
 */
export function createHttpRequestHandler(
  router: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  shutdownManager: IShutdownManager,
  server: Server,
): (req: IncomingMessage, res: ServerResponse) => void {
  const isStopping = () => shutdownManager.isShuttingDown(server);
  return (req: IncomingMessage, res: ServerResponse): void => {
    handleIncomingRequest(req, res, isStopping, router);
  };
}
