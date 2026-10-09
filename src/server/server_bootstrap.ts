/**
 * Server Launcher and Bootstrap Coordination Module.
 *
 * @packageDocumentation
 */

import { logger as defaultLogger } from '../logger/logger.ts';
import { defaultShutdownManager } from '../shutdown/shutdown_handler.ts';
import { defaultSignalRegistry } from '../signal/signal_handler.ts';
import { listenServer } from './server_binding.ts';
import {
  initializePipeline,
  assembleServerInstance,
  type ServerPipeline,
  type AssembledServer,
} from './server_pipeline.ts';
import type {
  IServerLauncher,
  IShutdownManager,
  ISignalHandlerRegistry,
  ServerInstance,
  StartServerOptions,
} from './server_types.ts';

interface ListenArgs {
  readonly pipe: ServerPipeline;
  readonly assembled: AssembledServer;
  readonly options: StartServerOptions;
}

async function bindAndListen(args: ListenArgs): Promise<ServerInstance> {
  const { pipe, assembled, options } = args;
  const logger = options.logger ?? defaultLogger;
  const { server, config } = pipe;
  const { instance, cleanupSignals: cleanupSignalHandlers } = assembled;
  await listenServer({ server, instance, config, logger, cleanupSignalHandlers });
  return instance;
}

/**
 * Default implementation of {@link IServerLauncher} coordinating server initialization.
 */
export class HttpServerLauncher implements IServerLauncher {
  private readonly shutdownManager: IShutdownManager;
  private readonly signalRegistry: ISignalHandlerRegistry;

  public constructor(
    shutdownManager: IShutdownManager = defaultShutdownManager,
    signalRegistry: ISignalHandlerRegistry = defaultSignalRegistry,
  ) {
    this.shutdownManager = shutdownManager;
    this.signalRegistry = signalRegistry;
  }

  public async start(options: StartServerOptions = {}): Promise<ServerInstance> {
    const pipe = initializePipeline(options, this.shutdownManager);
    const assembled = assembleServerInstance(
      pipe,
      options,
      this.shutdownManager,
      this.signalRegistry,
    );
    return bindAndListen({ pipe, assembled, options });
  }
}

/**
 * Default singleton instance of {@link IServerLauncher}.
 */
export const defaultServerLauncher: IServerLauncher = new HttpServerLauncher(
  defaultShutdownManager,
  defaultSignalRegistry,
);

/**
 * Initializes, configures, and starts the HTTP server.
 *
 * @param options - Server startup configuration options.
 * @returns Initialized and listening {@link ServerInstance}.
 */
export async function startServer(options: StartServerOptions = {}): Promise<ServerInstance> {
  return defaultServerLauncher.start(options);
}
