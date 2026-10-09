/**
 * Graceful Server Shutdown Management Module.
 *
 * Coordinates graceful HTTP server connection draining, idle socket termination,
 * fallback timeout destruction, and process exit handlers.
 *
 * @packageDocumentation
 */

import type { Server } from 'node:http';
import { executeShutdown } from './shutdown_pipeline.ts';
import type { IShutdownManager, ShutdownOptions } from '../server/server_types.ts';

/**
 * Tracks in-flight or completed shutdown promises keyed by {@link Server} instance.
 */
export const serverShutdownPromises = new WeakMap<Server, Promise<void>>();

/**
 * Default implementation of {@link IShutdownManager} coordinating graceful HTTP server shutdown.
 */
export class GracefulShutdownManager implements IShutdownManager {
  private readonly shutdownPromises: WeakMap<Server, Promise<void>>;

  public constructor(shutdownPromises: WeakMap<Server, Promise<void>> = serverShutdownPromises) {
    this.shutdownPromises = shutdownPromises;
  }

  public isShuttingDown(server: Server): boolean {
    return this.shutdownPromises.has(server);
  }

  public shutdown(server: Server, options: ShutdownOptions = {}): Promise<void> {
    const existing = this.shutdownPromises.get(server);
    if (existing) {
      return existing;
    }
    const promise = executeShutdown(server, options);
    this.shutdownPromises.set(server, promise);
    return promise;
  }
}

/**
 * Default singleton instance of {@link IShutdownManager}.
 */
export const defaultShutdownManager: IShutdownManager = new GracefulShutdownManager(
  serverShutdownPromises,
);

/**
 * Gracefully shuts down an active HTTP server instance by draining in-flight requests and terminating connections.
 *
 * @param server - The Node.js HTTP server instance to shut down.
 * @param options - Optional {@link ShutdownOptions} controlling timeout, process exit, logging, socket tracking, and completion callback.
 * @returns A promise that resolves when the server has closed and all connections have terminated, or rejects on error.
 */
export function shutdownServer(server: Server, options: ShutdownOptions = {}): Promise<void> {
  return defaultShutdownManager.shutdown(server, options);
}
