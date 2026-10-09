/**
 * Server Bootstrap and Lifecycle Management Module.
 *
 * @packageDocumentation
 */

import { logger as defaultLogger } from './logger/logger.ts';
import { EXIT_CODE_ERROR } from './server/server_constants.ts';
import { loggedStartupErrors } from './server/server_binding.ts';
import { flushAndExit, registerFatalProcessHandlers } from './server/server_flush.ts';
import { isEntrypointModule } from './cli_entrypoint.ts';
import { startServer } from './server/server_bootstrap.ts';

export {
  type ServerLogger,
  type ServerInstance,
  type StartServerOptions,
  type ShutdownOptions,
  type SignalHandlerOptions,
  type IConnectionTracker,
  type IShutdownManager,
  type ISignalHandlerRegistry,
  type IServerLauncher,
} from './server/server_types.ts';

export { SocketConnectionTracker } from './socket_tracker.ts';
export { GracefulShutdownManager, shutdownServer } from './shutdown/shutdown_handler.ts';
export { SignalHandlerRegistry, registerSignalHandlers } from './signal/signal_handler.ts';
export { HttpServerLauncher, startServer } from './server/server_bootstrap.ts';
export { flushAndExit, registerFatalProcessHandlers } from './server/server_flush.ts';

/**
 * Determines whether the server entrypoint (`index.ts`) was executed directly.
 *
 * @param metaUrl - The file URL to check. Defaults to this module's `import.meta.url`.
 * @param argv1 - The entry-point script path. Defaults to `process.argv[1]`.
 */
export function isMainModule(metaUrl: string = import.meta.url, argv1?: string): boolean {
  return isEntrypointModule(metaUrl, argv1);
}

function isLoggedStartupError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && loggedStartupErrors.has(err);
}

function logFatalStartupError(err: unknown): void {
  if (!isLoggedStartupError(err)) {
    defaultLogger.error('[server] Fatal server startup error:', { error: err });
  }
}

async function handleMainCliError(err: unknown): Promise<void> {
  logFatalStartupError(err);
  await flushAndExit(EXIT_CODE_ERROR);
}

if (isMainModule(import.meta.url)) {
  registerFatalProcessHandlers(defaultLogger);
  void startServer({ bindSignals: true }).catch(handleMainCliError);
}
