/**
 * Server pipeline initialization and assembly helpers.
 *
 * @packageDocumentation
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { ServerConfig } from '../config/config.ts';
import { createRouter } from '../router/router.ts';
import { logger as defaultLogger, toAppLogger } from '../logger/logger.ts';
import { SocketConnectionTracker } from '../socket_tracker.ts';
import { createHttpRequestHandler } from './server_request_handler.ts';
import { buildServerInstance, type ServerInstanceBuildContext } from './server_instance_builder.ts';
import {
  resolveEffectiveConfig,
  resolveStorage,
  logOverridesIfPresent,
} from './server_config_resolver.ts';
import { setupInstanceSignals } from './server_signal_binding.ts';
import type {
  IShutdownManager,
  ISignalHandlerRegistry,
  ServerInstance,
  StartServerOptions,
} from './server_types.ts';

function createHttpServer(
  router: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  shutdownManager: IShutdownManager,
): Server {
  const server = createServer();
  const handler = createHttpRequestHandler(router, shutdownManager, server);
  server.on('request', handler);
  return server;
}

function trackServerSockets(server: Server): Set<Socket> {
  const tracker = new SocketConnectionTracker();
  tracker.track(server);
  return tracker.getSockets() as Set<Socket>;
}

/**
 * Encapsulates initialized server HTTP resources.
 */
export interface ServerPipeline {
  readonly config: ServerConfig;
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

function createPipelineServer(
  options: StartServerOptions,
  config: ServerConfig,
  shutdownManager: IShutdownManager,
): Server {
  const appLogger = toAppLogger(options.logger);
  const storage = resolveStorage(options, config, appLogger);
  const router = createRouter({ storageService: storage, logger: appLogger });
  return createHttpServer(router, shutdownManager);
}

/**
 * Initializes configuration, storage, router, and HTTP server for startup.
 */
export function initializePipeline(
  options: StartServerOptions,
  shutdownManager: IShutdownManager,
): ServerPipeline {
  const config = resolveEffectiveConfig(options, toAppLogger(options.logger));
  logOverridesIfPresent(options, config, defaultLogger);
  const server = createPipelineServer(options, config, shutdownManager);
  return { config, server, sockets: trackServerSockets(server) };
}

/**
 * Result of server instance assembly.
 */
export interface AssembledServer {
  readonly instance: ServerInstance;
  readonly cleanupSignals: () => void;
}

function makeBuildContext(
  pipeline: ServerPipeline,
  options: StartServerOptions,
  shutdownManager: IShutdownManager,
): ServerInstanceBuildContext {
  const { server, config: effectiveConfig, sockets } = pipeline;
  return { server, effectiveConfig, sockets, shutdownManager, options };
}

/**
 * Assembles a {@link ServerInstance} and sets up signal handlers if configured.
 */
export function assembleServerInstance(
  pipe: ServerPipeline,
  opts: StartServerOptions,
  mgr: IShutdownManager,
  reg: ISignalHandlerRegistry,
): AssembledServer {
  const ctx = makeBuildContext(pipe, opts, mgr);
  const instance = buildServerInstance(ctx);
  return { instance, cleanupSignals: setupInstanceSignals(ctx, instance, reg) };
}
