/**
 * Server Shutdown Connection and Request Interceptor.
 *
 * Provides connection draining mechanisms, idle socket closure,
 * and HTTP response connection-close header injection during graceful shutdown.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { logDecision } from '../logger/logger.ts';
import type { ServerLogger } from '../server/server_types.ts';

function destroySocketSet(sockets?: Set<Socket> | ReadonlySet<Socket>): void {
  if (sockets) {
    for (const socket of sockets) {
      socket.destroy();
    }
  }
}

/**
 * Forcibly destroys remaining network sockets.
 *
 * @param server - The Node.js HTTP server.
 * @param sockets - Tracked socket set.
 */
export function forceCloseConnections(
  server: Server,
  sockets?: Set<Socket> | ReadonlySet<Socket>,
): void {
  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
    return;
  }
  destroySocketSet(sockets);
}

function logIdleCloseDecision(logger: ServerLogger): void {
  logDecision(logger, {
    action: 'ServerShutdown',
    choice: 'close idle keep-alive connections',
    reason:
      'server.closeIdleConnections() supported by runtime, terminating idle keep-alive sockets immediately',
    level: 'debug',
  });
}

/**
 * Closes idle keep-alive connections immediately if supported by the Node.js runtime.
 *
 * @param server - The HTTP server instance.
 * @param logger - Logger for recording diagnostic decisions.
 */
export function closeIdleConnectionsIfSupported(server: Server, logger: ServerLogger): void {
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
    logIdleCloseDecision(logger);
  }
}

function isSocketActive(socket: Socket | null): socket is Socket {
  return Boolean(socket && !socket.destroyed);
}

function destroyUnendedSocket(socket: Socket | null, res: ServerResponse): void {
  if (isSocketActive(socket) && !res.writableEnded) {
    socket.destroy();
  }
}

function endActiveSocket(socket: Socket | null): void {
  if (isSocketActive(socket)) {
    socket.end();
  }
}

/**
 * Attaches socket teardown listeners to an active response during shutdown.
 *
 * @param res - The active HTTP server response.
 * @param socket - The connection socket, captured while still attached to the response
 * (Node detaches `res.socket` before `finish`/`close` listeners run).
 */
export function attachResponseSocketDrainer(res: ServerResponse, socket = res.socket): void {
  res.on('finish', () => {
    endActiveSocket(socket);
  });
  res.on('close', () => {
    destroyUnendedSocket(socket, res);
  });
}

function handleShuttingDownRequest(req: IncomingMessage, res: ServerResponse): void {
  if (!res.headersSent) {
    res.setHeader('Connection', 'close');
  }
  attachResponseSocketDrainer(res, req.socket);
}

/**
 * Creates an HTTP request listener that marks incoming responses with `Connection: close`.
 */
export function createShutdownRequestInterceptor(): (
  req: IncomingMessage,
  res: ServerResponse,
) => void {
  return handleShuttingDownRequest;
}
