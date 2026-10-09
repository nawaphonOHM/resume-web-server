/**
 * Process Signal Handler Registry Module.
 *
 * Registers and unregisters OS process signal listeners (`SIGTERM`, `SIGINT`)
 * to trigger graceful server shutdown workflows.
 *
 * @packageDocumentation
 */

import { logger as defaultLogger } from '../logger/logger.ts';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from '../server/server_constants.ts';
import { defaultShutdownManager } from '../shutdown/shutdown_handler.ts';
import { logDuplicateSignal, logHandleSignal } from './signal_telemetry.ts';
import { bindProcessSignals } from './signal_listener.ts';
import type {
  ISignalHandlerRegistry,
  IShutdownManager,
  ServerInstance,
  ServerLogger,
  SignalHandlerOptions,
} from '../server/server_types.ts';

interface SignalDispatchConfig {
  readonly logger: ServerLogger;
  readonly timeoutMs: number;
  readonly exitProcess: boolean;
  readonly sockets?: ServerInstance['sockets'];
}

function resolveSignalExit(exitProcess?: boolean): boolean {
  return exitProcess !== false;
}

function resolveSignalSockets(
  instance: ServerInstance,
  sockets?: ServerInstance['sockets'],
): ServerInstance['sockets'] {
  return sockets ?? instance.sockets;
}

function resolveSignalConfig(
  inst: ServerInstance,
  opts: SignalHandlerOptions,
): SignalDispatchConfig {
  const logger = opts.logger ?? defaultLogger;
  const timeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exitProcess = resolveSignalExit(opts.exitProcess);
  const sockets = resolveSignalSockets(inst, opts.sockets);
  return { logger, timeoutMs, exitProcess, sockets };
}

function executeSignalShutdown(
  manager: IShutdownManager,
  server: ServerInstance['server'],
  cfg: SignalDispatchConfig,
): void {
  const { timeoutMs, exitProcess, logger, sockets } = cfg;
  void manager.shutdown(server, { timeoutMs, exitProcess, logger, sockets });
}

function dispatchActiveSignal(
  manager: IShutdownManager,
  server: ServerInstance['server'],
  signal: string,
  cfg: SignalDispatchConfig,
): void {
  logHandleSignal(cfg.logger, signal, cfg);
  executeSignalShutdown(manager, server, cfg);
}

interface SignalTriggerPayload {
  readonly manager: IShutdownManager;
  readonly instance: ServerInstance;
  readonly signal: string;
  readonly config: SignalDispatchConfig;
}

function dispatchSignalShutdown(payload: SignalTriggerPayload): void {
  const { manager, instance, signal, config } = payload;
  if (manager.isShuttingDown(instance.server)) {
    logDuplicateSignal(config.logger, signal);
    return;
  }
  dispatchActiveSignal(manager, instance.server, signal, config);
}

function makeSignalTrigger(
  manager: IShutdownManager,
  instance: ServerInstance,
  config: SignalDispatchConfig,
): (signal: string) => void {
  return (signal) => {
    dispatchSignalShutdown({ manager, instance, signal, config });
  };
}

/**
 * Default implementation of {@link ISignalHandlerRegistry} managing OS process signals.
 */
export class SignalHandlerRegistry implements ISignalHandlerRegistry {
  private readonly shutdownManager: IShutdownManager;

  public constructor(shutdownManager: IShutdownManager = defaultShutdownManager) {
    this.shutdownManager = shutdownManager;
  }

  public register(serverInstance: ServerInstance, options: SignalHandlerOptions = {}): () => void {
    const cfg = resolveSignalConfig(serverInstance, options);
    const trigger = makeSignalTrigger(this.shutdownManager, serverInstance, cfg);
    return bindProcessSignals(trigger);
  }
}

/**
 * Default singleton instance of {@link ISignalHandlerRegistry}.
 */
export const defaultSignalRegistry: ISignalHandlerRegistry = new SignalHandlerRegistry(
  defaultShutdownManager,
);

/**
 * Registers process signal listeners (`SIGTERM` and `SIGINT`) to trigger graceful server shutdown.
 *
 * @param serverInstance - The running {@link ServerInstance}.
 * @param options - Optional configuration overrides for signal-triggered shutdown.
 * @returns A teardown function that unregisters the listeners from `process`.
 */
export function registerSignalHandlers(
  serverInstance: ServerInstance,
  options: SignalHandlerOptions = {},
): () => void {
  return defaultSignalRegistry.register(serverInstance, options);
}
