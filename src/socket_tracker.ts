/**
 * Socket Connection Tracking Module.
 *
 * Provides connection state monitoring to track active network sockets,
 * supporting connection lifecycle observation and forced teardown during server shutdown.
 *
 * @packageDocumentation
 */

import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { IConnectionTracker } from './server/server_types.ts';

/**
 * Default implementation of {@link IConnectionTracker} managing a set of active sockets.
 */
export class SocketConnectionTracker implements IConnectionTracker {
  /**
   * Set of currently active client sockets.
   */
  private readonly sockets: Set<Socket> = new Set<Socket>();

  /**
   * Attaches connection tracking listeners to the server.
   *
   * @param server - The HTTP server.
   */
  public track(server: Server): void {
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => {
        this.sockets.delete(socket);
      });
    });
  }

  /**
   * Retrieves the readonly set of tracked sockets.
   */
  public getSockets(): ReadonlySet<Socket> {
    return this.sockets;
  }

  /**
   * Forcibly destroys all tracked sockets.
   */
  public destroyAll(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }
}
