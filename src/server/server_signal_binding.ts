/**
 * Server instance signal registration and cleanup binding.
 *
 * @packageDocumentation
 */

import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from './server_constants.ts';
import type { ServerInstanceBuildContext } from './server_instance_builder.ts';
import type {
  ISignalHandlerRegistry,
  ServerInstance,
  SignalHandlerOptions,
  StartServerOptions,
} from './server_types.ts';

function makeSignalOptions(inst: ServerInstance, opts: StartServerOptions): SignalHandlerOptions {
  return {
    shutdownTimeoutMs: opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    exitProcess: true,
    logger: opts.logger,
    sockets: inst.sockets,
  };
}

function bindSignalsIfRequested(
  registry: ISignalHandlerRegistry,
  instance: ServerInstance,
  options: StartServerOptions,
): (() => void) | undefined {
  if (options.bindSignals === false) {
    return undefined;
  }
  return registry.register(instance, makeSignalOptions(instance, options));
}

function makeCleanupFn(buildCtx: ServerInstanceBuildContext): () => void {
  return () => {
    if (buildCtx.removeSignalHandlers) {
      buildCtx.removeSignalHandlers();
      buildCtx.removeSignalHandlers = undefined;
    }
  };
}

/**
 * Attaches process signal handlers to the server instance and returns a cleanup callback.
 *
 * @param buildCtx - Server instance build context.
 * @param instance - Built server instance.
 * @param registry - Signal handler registry.
 * @returns Cleanup function to unbind signal handlers.
 */
export function setupInstanceSignals(
  buildCtx: ServerInstanceBuildContext,
  instance: ServerInstance,
  registry: ISignalHandlerRegistry,
): () => void {
  buildCtx.removeSignalHandlers = bindSignalsIfRequested(registry, instance, buildCtx.options);
  return makeCleanupFn(buildCtx);
}
