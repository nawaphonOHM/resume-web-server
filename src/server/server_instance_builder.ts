/**
 * Server instance construction and property resolution helpers.
 *
 * @packageDocumentation
 */

import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { ServerConfig } from '../config/config.ts';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from './server_constants.ts';
import type { IShutdownManager, ServerInstance, StartServerOptions } from './server_types.ts';

/**
 * Context required to build a {@link ServerInstance}.
 */
export interface ServerInstanceBuildContext {
  readonly server: Server;
  readonly effectiveConfig: ServerConfig;
  readonly sockets: Set<Socket>;
  readonly shutdownManager: IShutdownManager;
  readonly options: StartServerOptions;
  removeSignalHandlers?: () => void;
}

function getBoundPort(server: Server, fallback: number): number {
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    return addr.port;
  }
  return fallback;
}

function getBoundHost(server: Server, fallback: string): string {
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    return addr.address;
  }
  return fallback;
}

function cleanupSignalHandlers(ctx: ServerInstanceBuildContext): void {
  if (ctx.removeSignalHandlers) {
    ctx.removeSignalHandlers();
    ctx.removeSignalHandlers = undefined;
  }
}

function makeCloseOptions(ctx: ServerInstanceBuildContext) {
  const timeoutMs = ctx.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  return { timeoutMs, exitProcess: false, logger: ctx.options.logger, sockets: ctx.sockets };
}

function executeShutdownClose(ctx: ServerInstanceBuildContext): Promise<void> {
  cleanupSignalHandlers(ctx);
  return ctx.shutdownManager.shutdown(ctx.server, makeCloseOptions(ctx));
}

function createCloseHandler(ctx: ServerInstanceBuildContext): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return (): Promise<void> => {
    closePromise ??= executeShutdownClose(ctx);
    return closePromise;
  };
}

function createBaseInstance(ctx: ServerInstanceBuildContext): ServerInstance {
  const { server, effectiveConfig: config, sockets } = ctx;
  const { port, host } = config;
  return { server, config, sockets, port, host, close: createCloseHandler(ctx) };
}

function createAddressAccessors(ctx: ServerInstanceBuildContext): PropertyDescriptorMap {
  const { server, effectiveConfig: config } = ctx;
  return {
    port: { get: () => getBoundPort(server, config.port) },
    host: { get: () => getBoundHost(server, config.host) },
  };
}

/**
 * Constructs a fully initialized {@link ServerInstance} wrapper whose `port` and `host`
 * accessors are evaluated lazily against the bound server address.
 */
export function buildServerInstance(ctx: ServerInstanceBuildContext): ServerInstance {
  return Object.defineProperties(createBaseInstance(ctx), createAddressAccessors(ctx));
}
