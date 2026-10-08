/**
 * Server Bootstrap and Lifecycle Management Module.
 *
 * Provides functions and interfaces to configure, start, and gracefully shut down
 * the Node.js HTTP server following SOLID principles. Manages active socket tracking, keep-alive connection draining,
 * timeout-based socket destruction, OS process signal handling (`SIGTERM`, `SIGINT`),
 * and main CLI entry-point detection.
 *
 * @remarks
 * The graceful shutdown sequence adheres to the following workflow:
 * 1. Checks internal {@link serverShutdownPromises} `WeakMap` for an existing shutdown; if found, returns the cached promise (subsequent calls and their options are ignored).
 * 2. Schedules a fallback timeout timer (default: 8000ms) to force-destroy remaining sockets if draining exceeds the deadline.
 * 3. Closes idle keep-alive sockets immediately via `server.closeIdleConnections()` if supported.
 * 4. Intercepts incoming requests during shutdown to set `Connection: close` headers and end/destroy sockets upon response completion.
 * 5. Calls `server.close()` to stop accepting new connections and await in-flight request completion.
 * 6. Invokes the optional `onShutdownComplete` callback and optionally terminates the Node.js process via `process.exit`.
 *
 * @packageDocumentation
 */

import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { type ServerConfig, loadConfig } from './config.ts';
import { createRouter } from './router.ts';
import { createStorageService, type StorageService } from './storage.ts';
import {
  logger as defaultLogger,
  type AppLogger,
  type DecisionLogPayload,
  logDecision,
  toAppLogger,
} from './logger.ts';

/**
 * Application logger interface for recording server lifecycle events and diagnostic messages.
 */
export interface ServerLogger {
  /**
   * Logs an informational message.
   *
   * @param message - The informational message text.
   * @param args - Additional diagnostic arguments or contextual objects.
   */
  info(message: string, ...args: unknown[]): void;

  /**
   * Logs an error message or Error object.
   *
   * @param message - The error message text or Error instance.
   * @param args - Additional error details, exception instances, or contextual metadata.
   */
  error(message: string | Error, ...args: unknown[]): void;

  /**
   * Logs an optional warning message or Error.
   *
   * @param message - The warning message text or Error instance.
   * @param args - Additional warning details or contextual metadata.
   */
  warn?(message: string | Error, ...args: unknown[]): void;

  /**
   * Logs an optional debug diagnostic message.
   *
   * @param message - The debug message text.
   * @param args - Additional diagnostic arguments or contextual metadata.
   */
  debug?(message: string, ...args: unknown[]): void;

  /**
   * Logs an optional HTTP-level message.
   *
   * @param message - The HTTP log message text.
   * @param args - Additional diagnostic arguments or contextual metadata.
   */
  http?(message: string, ...args: unknown[]): void;

  /**
   * Logs an optional structured operational decision.
   *
   * @param payload - Structured decision payload.
   */
  decision?(payload: DecisionLogPayload): void;
}

/**
 * Represents an active, running HTTP server instance and its operational controls.
 */
export interface ServerInstance {
  /**
   * The underlying Node.js HTTP server instance.
   */
  readonly server: Server;

  /**
   * The actual TCP port number the server is bound to and listening on.
   *
   * @remarks
   * Dynamically resolved from `server.address()` if available; otherwise reflects the configured port.
   */
  readonly port: number;

  /**
   * The actual host interface or IP address the server is bound to.
   *
   * @remarks
   * Dynamically resolved from `server.address()` if available; otherwise reflects the configured host.
   */
  readonly host: string;

  /**
   * The effective {@link ServerConfig} resolved during server startup.
   */
  readonly config: ServerConfig;

  /**
   * The set of currently active client network sockets tracked by the server.
   */
  readonly sockets?: ReadonlySet<Socket>;

  /**
   * Initiates a graceful shutdown of the server, unregistering signal handlers if bound.
   *
   * @remarks
   * Invokes {@link shutdownServer} with `exitProcess: false`.
   *
   * @returns A promise that resolves when all connections are drained and the server stops listening, or rejects on error.
   */
  close(): Promise<void>;
}

/**
 * Options for configuring and starting the HTTP server.
 */
export interface StartServerOptions {
  /**
   * Partial configuration overrides.
   *
   * @remarks
   * Overrides provided here take precedence over environment variables and defaults from {@link loadConfig}.
   * Note that direct property overrides bypass the validation logic performed in `loadConfig` (e.g. port range constraints).
   */
  readonly config?: Partial<ServerConfig>;

  /**
   * Custom storage service implementation for serving assets.
   *
   * @defaultValue Created via {@link createStorageService} using the effective configuration.
   */
  readonly storageService?: StorageService;

  /**
   * Whether to automatically register process signal handlers (`SIGTERM` and `SIGINT`) for graceful shutdown.
   *
   * @remarks
   * When enabled, signal-triggered shutdown runs with `exitProcess: true`, terminating the process
   * (`process.exit(0)` on success, `process.exit(1)` on failure).
   *
   * @defaultValue `true`
   */
  readonly bindSignals?: boolean;

  /**
   * Maximum duration in milliseconds to allow active connections to finish before forcing closure during shutdown.
   *
   * @defaultValue `8000`
   */
  readonly shutdownTimeoutMs?: number;

  /**
   * Custom logger implementation for recording server events.
   *
   * @defaultValue {@link defaultLogger}
   */
  readonly logger?: ServerLogger;
}

/**
 * Options controlling the behavior of the graceful server shutdown process.
 *
 * @remarks
 * Note that when multiple calls to {@link shutdownServer} occur for the same server instance,
 * only the options passed to the first (initiating) call are honored. Subsequent calls return the
 * initial cached promise and ignore their own options and callbacks.
 */
export interface ShutdownOptions {
  /**
   * Maximum duration in milliseconds to wait for active connections to drain before force-closing sockets.
   *
   * @remarks
   * If set to a value less than or equal to `0`, no timeout timer is scheduled.
   *
   * @defaultValue `8000`
   */
  readonly timeoutMs?: number;

  /**
   * Whether to terminate the Node.js process upon shutdown completion (`process.exit(0)` on success, `process.exit(1)` on error).
   *
   * @remarks
   * When set to `false`, errors during shutdown are returned as promise rejections. If shutdown was triggered
   * without awaiting the returned promise (such as in an unhandled signal callback), this can result in an unhandled promise rejection.
   *
   * @defaultValue `false`
   */
  readonly exitProcess?: boolean;

  /**
   * Logger used to record shutdown progress, warnings, and errors.
   *
   * @defaultValue {@link defaultLogger}
   */
  readonly logger?: ServerLogger;

  /**
   * Set of active client sockets to forcefully destroy if the shutdown timeout expires and `server.closeAllConnections` is unavailable.
   */
  readonly sockets?: Set<Socket> | ReadonlySet<Socket>;

  /**
   * Optional callback invoked once the shutdown process completes (on both success and error), prior to promise settlement or process exit.
   *
   * @remarks
   * Only executes if this call was the initial call that started the shutdown sequence. Ignored on subsequent calls.
   */
  readonly onShutdownComplete?: () => void;
}

/**
 * Options for registering process signal handlers.
 */
export interface SignalHandlerOptions {
  /**
   * Maximum duration in milliseconds to wait before forcing socket destruction.
   */
  readonly shutdownTimeoutMs?: number;

  /**
   * Whether to exit the process when graceful shutdown finishes.
   */
  readonly exitProcess?: boolean;

  /**
   * Logger used to record signal handling events.
   *
   * @defaultValue {@link defaultLogger}
   */
  readonly logger?: ServerLogger;

  /**
   * Set of active client sockets override.
   */
  readonly sockets?: Set<Socket> | ReadonlySet<Socket>;
}

/**
 * Contract for tracking active HTTP client socket connections (Single Responsibility Principle).
 */
export interface IConnectionTracker {
  /**
   * Attaches connection and close listeners to an HTTP server instance.
   *
   * @param server - The server instance to track connections for.
   */
  track(server: Server): void;

  /**
   * Returns the set of currently active client sockets.
   */
  getSockets(): ReadonlySet<Socket>;

  /**
   * Forcibly closes all tracked active sockets.
   */
  destroyAll(): void;
}

/**
 * Contract for managing graceful server shutdown sequences (Single Responsibility Principle).
 */
export interface IShutdownManager {
  /**
   * Initiates a graceful shutdown of the specified HTTP server.
   *
   * @param server - The Node.js HTTP server instance.
   * @param options - Configuration options for shutdown.
   * @returns A promise that settles when shutdown finishes.
   */
  shutdown(server: Server, options?: ShutdownOptions): Promise<void>;

  /**
   * Checks whether a graceful shutdown is currently in-flight or completed for the server.
   *
   * @param server - The HTTP server instance to check.
   */
  isShuttingDown(server: Server): boolean;
}

/**
 * Contract for registering and tearing down OS signal handlers (Single Responsibility Principle).
 */
export interface ISignalHandlerRegistry {
  /**
   * Registers `SIGTERM` and `SIGINT` listeners to trigger graceful shutdown on the provided server instance.
   *
   * @param serverInstance - The running server instance.
   * @param options - Configuration options for signal shutdown.
   * @returns A teardown function to unbind signal listeners from `process`.
   */
  register(serverInstance: ServerInstance, options?: SignalHandlerOptions): () => void;
}

/**
 * Contract for initializing and launching the HTTP server (Single Responsibility Principle).
 */
export interface IServerLauncher {
  /**
   * Launches the HTTP server and binds to configured network interface.
   *
   * @param options - Startup configuration options.
   * @returns A promise resolving to the active {@link ServerInstance}.
   */
  start(options?: StartServerOptions): Promise<ServerInstance>;
}

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

/**
 * Tracks in-flight or completed shutdown promises keyed by {@link Server} instance.
 */
const serverShutdownPromises = new WeakMap<Server, Promise<void>>();

/**
 * Tracks errors that were already logged during server startup binding to prevent duplicate logging.
 */
const loggedStartupErrors = new WeakSet();

/**
 * Default implementation of {@link IShutdownManager} coordinating graceful HTTP server shutdown.
 */
export class GracefulShutdownManager implements IShutdownManager {
  /**
   * Internal promise cache storing shutdown promises by server.
   */
  private readonly shutdownPromises: WeakMap<Server, Promise<void>>;

  /**
   * Creates a new `GracefulShutdownManager`.
   *
   * @param shutdownPromises - Optional WeakMap cache for shutdown promises.
   */
  public constructor(shutdownPromises: WeakMap<Server, Promise<void>> = serverShutdownPromises) {
    this.shutdownPromises = shutdownPromises;
  }

  /**
   * Checks whether a shutdown is in progress or completed for the server.
   *
   * @param server - The HTTP server.
   */
  public isShuttingDown(server: Server): boolean {
    return this.shutdownPromises.has(server);
  }

  /**
   * Gracefully shuts down the HTTP server.
   *
   * @param server - The HTTP server to close.
   * @param options - Shutdown configuration options.
   */
  public shutdown(server: Server, options: ShutdownOptions = {}): Promise<void> {
    const existingPromise = this.shutdownPromises.get(server);
    if (existingPromise) {
      return existingPromise;
    }

    const logger = options.logger ?? defaultLogger;
    const timeoutMs = options.timeoutMs ?? 8000;
    const exitProcess = options.exitProcess ?? false;
    const sockets = options.sockets;

    const shutdownPromise = new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;

      logDecision(logger, {
        action: 'ServerShutdown',
        choice: 'initiate graceful shutdown',
        reason: 'Closing HTTP server and draining in-flight connections',
        level: 'info',
        timeoutMs,
        exitProcess,
        trackedSockets: sockets ? sockets.size : 0,
      });

      const forceCloseConnections = () => {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        } else if (sockets) {
          for (const socket of sockets) {
            socket.destroy();
          }
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const remaining = sockets ? sockets.size : 'unknown';
          logDecision(logger, {
            action: 'ServerShutdown',
            choice: 'force-destroy remaining connections',
            reason: `Shutdown timeout reached (${String(timeoutMs)}ms) before all connections drained`,
            level: 'warn',
            remainingSockets: remaining,
            timeoutMs,
          });
          forceCloseConnections();
        }, timeoutMs);
        timer.unref();
      }

      // Attempt to close idle keep-alive connections immediately
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
        logDecision(logger, {
          action: 'ServerShutdown',
          choice: 'close idle keep-alive connections',
          reason:
            'server.closeIdleConnections() supported by runtime, terminating idle keep-alive sockets immediately',
          level: 'debug',
        });
      }

      const onRequestWhileShuttingDown = (
        _req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
      ) => {
        if (!res.headersSent) {
          res.setHeader('Connection', 'close');
        }
        const socket = res.socket;
        res.on('finish', () => {
          if (socket && !socket.destroyed) {
            socket.end();
          }
        });
        res.on('close', () => {
          if (socket && !socket.destroyed && !res.writableEnded) {
            socket.destroy();
          }
        });
      };
      server.on('request', onRequestWhileShuttingDown);

      server.close((err) => {
        server.off('request', onRequestWhileShuttingDown);
        if (timer) {
          clearTimeout(timer);
        }
        if (err) {
          logDecision(logger, {
            action: 'ServerShutdown',
            choice: 'shutdown failure',
            reason: `Server failed to close cleanly: ${err.message}`,
            level: 'error',
            error: err,
          });
          options.onShutdownComplete?.();
          if (exitProcess) {
            void flushAndExit(1);
          }
          reject(err);
          return;
        }

        logDecision(logger, {
          action: 'ServerShutdown',
          choice: 'shutdown complete',
          reason: 'All active connections drained and server closed successfully',
          level: 'info',
        });
        options.onShutdownComplete?.();
        if (exitProcess) {
          void flushAndExit(0);
        }
        resolve();
      });
    });

    this.shutdownPromises.set(server, shutdownPromise);
    return shutdownPromise;
  }
}

/**
 * Default implementation of {@link ISignalHandlerRegistry} managing OS process signals.
 */
export class SignalHandlerRegistry implements ISignalHandlerRegistry {
  /**
   * Shutdown manager strategy.
   */
  private readonly shutdownManager: IShutdownManager;

  /**
   * Creates a new `SignalHandlerRegistry`.
   *
   * @param shutdownManager - Injected shutdown manager. Defaults to {@link defaultShutdownManager}.
   */
  public constructor(shutdownManager: IShutdownManager = defaultShutdownManager) {
    this.shutdownManager = shutdownManager;
  }

  /**
   * Registers signal handlers for SIGTERM and SIGINT.
   *
   * @param serverInstance - Active server instance.
   * @param options - Signal shutdown configuration options.
   * @returns Teardown function removing listeners.
   */
  public register(serverInstance: ServerInstance, options: SignalHandlerOptions = {}): () => void {
    const logger = options.logger ?? defaultLogger;
    const timeoutMs = options.shutdownTimeoutMs ?? 8000;
    const exitProcess = options.exitProcess ?? true;
    const sockets = options.sockets ?? serverInstance.sockets;

    const onSignal = (signal: string) => {
      const isAlreadyShuttingDown = this.shutdownManager.isShuttingDown(serverInstance.server);
      if (isAlreadyShuttingDown) {
        logDecision(logger, {
          action: 'ProcessSignal',
          choice: `ignore duplicate ${signal}`,
          reason: 'Graceful shutdown is already in progress',
          level: 'info',
          signal,
        });
        return;
      }

      logDecision(logger, {
        action: 'ProcessSignal',
        choice: `handle ${signal}`,
        reason: `OS signal ${signal} received, triggering graceful shutdown workflow`,
        level: 'info',
        signal,
        timeoutMs,
        exitProcess,
      });
      void this.shutdownManager.shutdown(serverInstance.server, {
        timeoutMs,
        exitProcess,
        logger,
        sockets,
      });
    };

    const sigtermHandler = () => {
      onSignal('SIGTERM');
    };
    const sigintHandler = () => {
      onSignal('SIGINT');
    };

    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);

    return () => {
      process.off('SIGTERM', sigtermHandler);
      process.off('SIGINT', sigintHandler);
    };
  }
}

/**
 * Default implementation of {@link IServerLauncher} coordinating server initialization.
 */
export class HttpServerLauncher implements IServerLauncher {
  /**
   * Shutdown manager instance.
   */
  private readonly shutdownManager: IShutdownManager;

  /**
   * Signal registry instance.
   */
  private readonly signalRegistry: ISignalHandlerRegistry;

  /**
   * Creates a new `HttpServerLauncher`.
   *
   * @param shutdownManager - Injected shutdown manager. Defaults to {@link defaultShutdownManager}.
   * @param signalRegistry - Injected signal registry. Defaults to {@link defaultSignalRegistry}.
   */
  public constructor(
    shutdownManager: IShutdownManager = defaultShutdownManager,
    signalRegistry: ISignalHandlerRegistry = defaultSignalRegistry,
  ) {
    this.shutdownManager = shutdownManager;
    this.signalRegistry = signalRegistry;
  }

  /**
   * Initializes and starts the HTTP server.
   *
   * @param options - Server configuration and dependency options.
   */
  public async start(options: StartServerOptions = {}): Promise<ServerInstance> {
    const logger = options.logger ?? defaultLogger;
    const appLogger: AppLogger = toAppLogger(options.logger);

    const envConfig = loadConfig(process.env, appLogger);
    const effectiveConfig: ServerConfig = {
      port: options.config?.port ?? envConfig.port,
      host: options.config?.host ?? envConfig.host,
      bucketName: options.config?.bucketName ?? envConfig.bucketName,
      prefix: options.config?.prefix ?? envConfig.prefix,
    };

    if (options.config) {
      logDecision(logger, {
        action: 'ServerBootstrap',
        choice: 'apply explicit config overrides',
        reason: 'Configuration overrides supplied via StartServerOptions',
        level: 'debug',
        overrides: options.config,
        effectiveConfig,
      });
    }

    const storageService =
      options.storageService ??
      createStorageService({
        config: effectiveConfig,
        logger: appLogger,
      });
    const routerHandler = createRouter({
      storageService,
      logger: appLogger,
    });

    const server = createServer((req, res) => {
      const socket = req.socket;
      if (this.shutdownManager.isShuttingDown(server) && !res.headersSent) {
        res.setHeader('Connection', 'close');
      }

      res.on('finish', () => {
        if (this.shutdownManager.isShuttingDown(server) && !socket.destroyed) {
          socket.end();
        }
      });

      res.on('close', () => {
        if (
          this.shutdownManager.isShuttingDown(server) &&
          !socket.destroyed &&
          !res.writableEnded
        ) {
          socket.destroy();
        }
      });

      routerHandler(req, res).catch(() => {
        if (!res.headersSent && !res.destroyed && !res.writableEnded) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end('Internal Server Error');
        }
      });
    });

    const connectionTracker = new SocketConnectionTracker();
    connectionTracker.track(server);
    const sockets = connectionTracker.getSockets() as Set<Socket>;

    let removeSignalHandlers: (() => void) | undefined;
    let closePromise: Promise<void> | undefined;

    const close = (): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }
      if (removeSignalHandlers) {
        removeSignalHandlers();
        removeSignalHandlers = undefined;
      }
      closePromise = this.shutdownManager.shutdown(server, {
        timeoutMs: options.shutdownTimeoutMs ?? 8000,
        exitProcess: false,
        logger,
        sockets,
      });
      return closePromise;
    };

    const instance: ServerInstance = {
      server,
      get port() {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          return addr.port;
        }
        return effectiveConfig.port;
      },
      get host() {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          return addr.address;
        }
        return effectiveConfig.host;
      },
      config: effectiveConfig,
      sockets,
      close,
    };

    if (options.bindSignals !== false) {
      removeSignalHandlers = this.signalRegistry.register(instance, {
        shutdownTimeoutMs: options.shutdownTimeoutMs ?? 8000,
        exitProcess: true,
        logger,
        sockets,
      });
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        if (removeSignalHandlers) {
          removeSignalHandlers();
          removeSignalHandlers = undefined;
        }
        loggedStartupErrors.add(err);
        logDecision(logger, {
          action: 'ServerBinding',
          choice: 'binding failure',
          reason: `Server failed to bind to ${effectiveConfig.host}:${String(effectiveConfig.port)}: ${err.message}`,
          level: 'error',
          error: err,
        });
        reject(err);
      };

      server.once('error', onError);
      server.listen(effectiveConfig.port, effectiveConfig.host, () => {
        server.off('error', onError);
        logDecision(logger, {
          action: 'ServerBinding',
          choice: `bound to http://${instance.host}:${String(instance.port)}`,
          reason:
            'Server successfully bound to network interface and listening for incoming connections',
          level: 'info',
          port: instance.port,
          host: instance.host,
          bucketName: effectiveConfig.bucketName,
          prefix: effectiveConfig.prefix,
        });
        resolve();
      });
    });

    return instance;
  }
}

/**
 * Default singleton service instances.
 */
const defaultShutdownManager: IShutdownManager = new GracefulShutdownManager(
  serverShutdownPromises,
);
const defaultSignalRegistry: ISignalHandlerRegistry = new SignalHandlerRegistry(
  defaultShutdownManager,
);
const defaultServerLauncher: IServerLauncher = new HttpServerLauncher(
  defaultShutdownManager,
  defaultSignalRegistry,
);

/**
 * Gracefully shuts down an active HTTP server instance by draining in-flight requests and terminating connections.
 *
 * @remarks
 * Execution sequence:
 * 1. Checks {@link serverShutdownPromises} for an existing shutdown promise for the given `server`.
 *    If present, immediately returns that cached promise (even if already resolved or rejected).
 *    All options and callbacks provided to subsequent calls are completely ignored.
 * 2. Schedules an unreferenced timeout timer (when `options.timeoutMs > 0`) that will forcibly destroy remaining sockets
 *    via `server.closeAllConnections()` or by iterating `options.sockets` if the shutdown deadline is exceeded.
 * 3. Immediately closes idle keep-alive sockets using `server.closeIdleConnections()` if supported by the Node.js runtime.
 * 4. Attaches a temporary `'request'` listener on the server to inject `Connection: close` headers into any incoming responses
 *    and close sockets once their responses complete.
 * 5. Invokes `server.close()`, unregisters the temporary `'request'` listener, cancels the timeout timer, executes
 *    `options.onShutdownComplete?.()`, optionally exits the process (`process.exit(0)` on success, `process.exit(1)` on error),
 *    and settles the promise.
 *
 * @param server - The Node.js HTTP server instance to shut down.
 * @param options - Optional {@link ShutdownOptions} controlling timeout, process exit, logging, socket tracking, and completion callback.
 * @returns A promise that resolves when the server has closed and all connections have terminated, or rejects if `server.close()` reports an error.
 *
 * @example
 * ```ts
 * const instance = await startServer({ bindSignals: false });
 * await shutdownServer(instance.server, {
 *   timeoutMs: 5000,
 *   logger: console,
 * });
 * ```
 */
export function shutdownServer(server: Server, options: ShutdownOptions = {}): Promise<void> {
  return defaultShutdownManager.shutdown(server, options);
}

/**
 * Registers process signal listeners (`SIGTERM` and `SIGINT`) to trigger graceful server shutdown.
 *
 * @remarks
 * Attaches listeners to `process.on('SIGTERM')` and `process.on('SIGINT')`.
 * When a signal is intercepted:
 * - A log message is written via `options.logger`.
 * - {@link shutdownServer} is invoked synchronously (the returned promise is not awaited, i.e., `void shutdownServer(...)`).
 * - Default options passed to shutdown include `exitProcess: true` (unless overridden), which terminates the process via `process.exit` on completion.
 *
 * Important behavioral considerations:
 * - Registering these listeners overrides Node.js's default signal termination behavior (e.g. default SIGINT termination).
 *   If configured with `exitProcess: false`, the process will not exit on signals unless handled externally.
 * - If configured with `exitProcess: false` and `server.close()` fails, the resulting promise rejection is unhandled.
 * - The signal listeners remain attached to `process` after a signal fires; subsequent signals will invoke `shutdownServer` again,
 *   which returns the cached permanent promise from {@link serverShutdownPromises} and does not force termination.
 * - Call the returned teardown function to unbind both signal listeners from `process`.
 *
 * @param serverInstance - The running {@link ServerInstance} whose server and tracked sockets will be shut down.
 * @param options - Optional configuration overrides for signal-triggered shutdown:
 * - `shutdownTimeoutMs`: Timeout in milliseconds before forcing connections to close (default: `8000`).
 * - `exitProcess`: Whether to terminate the process after shutdown completes (default: `true`).
 * - `logger`: Custom logger instance (default: {@link defaultLogger}).
 * - `sockets`: Custom socket set override (default: `serverInstance.sockets`).
 * @returns A teardown function that unregisters the `SIGTERM` and `SIGINT` listeners from `process`.
 *
 * @example
 * ```ts
 * const instance = await startServer({ bindSignals: false });
 * const unregister = registerSignalHandlers(instance, {
 *   shutdownTimeoutMs: 10000,
 *   exitProcess: false,
 * });
 *
 * // Later, to remove signal traps:
 * unregister();
 * ```
 */
export function registerSignalHandlers(
  serverInstance: ServerInstance,
  options: SignalHandlerOptions = {},
): () => void {
  return defaultSignalRegistry.register(serverInstance, options);
}

/**
 * Initializes, configures, and starts the HTTP server.
 *
 * @remarks
 * Performs the following startup sequence:
 * 1. Resolves configuration by merging {@link loadConfig} defaults with `options.config`.
 *    Direct overrides in `options.config` take precedence and bypass `loadConfig` validation (e.g. port range validation).
 * 2. Initializes the {@link StorageService} (using `options.storageService` or creating a default instance via {@link createStorageService}).
 * 3. Configures the request router via {@link createRouter}.
 * 4. Instantiates the Node.js HTTP server, registering fallback error handling (responding with `500 Internal Server Error` if unhandled)
 *    and keep-alive connection draining via {@link serverShutdownPromises}.
 * 5. Binds `SIGTERM` and `SIGINT` signal handlers if `options.bindSignals !== false` (triggering shutdown with `exitProcess: true`).
 * 6. Begins listening on the configured port and host. If port binding or listening fails (e.g., `EADDRINUSE`),
 *    any registered signal handlers are automatically unbound and the returned promise rejects.
 *
 * @param options - Optional {@link StartServerOptions} configuring port/host, storage service, signal trapping, and logging.
 * @returns A promise that resolves to the initialized and listening {@link ServerInstance}.
 *
 * @throws Rejects with an `Error` if the server fails to bind or listen (for example, `EADDRINUSE`).
 *
 * @example
 * ```ts
 * const instance = await startServer({
 *   config: { port: 3000, host: '127.0.0.1' },
 *   bindSignals: true,
 *   shutdownTimeoutMs: 5000,
 * });
 * console.log(`Listening on http://${instance.host}:${String(instance.port)}`);
 *
 * // Gracefully stop when done:
 * await instance.close();
 * ```
 */
export async function startServer(options: StartServerOptions = {}): Promise<ServerInstance> {
  return defaultServerLauncher.start(options);
}

/**
 * Determines whether the current ES module was executed directly as the process entry point.
 *
 * @remarks
 * Compares the canonical filesystem paths of the module URL (resolved via `fileURLToPath` and `realpathSync`)
 * against `process.argv[1]` (resolved via `realpathSync`). Returns `false` if `argv1` is falsy (undefined, null, empty string)
 * or if canonical path resolution throws an exception (such as in virtualized or bundled environments).
 *
 * @param metaUrl - The file URL of the module being checked. Defaults to `import.meta.url`.
 * @param argv1 - The entry-point script path from `process.argv[1]`. Defaults to `process.argv[1]`.
 * @returns `true` if the module represented by `metaUrl` is the executed entry-point script; otherwise `false`.
 *
 * @example
 * ```ts
 * if (isMainModule(import.meta.url)) {
 *   console.log('Executed directly via CLI');
 * }
 * ```
 */
export function isMainModule(
  metaUrl: string = import.meta.url,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) {
    return false;
  }
  try {
    const scriptPath = fileURLToPath(metaUrl);
    return realpathSync(scriptPath) === realpathSync(argv1);
  } catch {
    return false;
  }
}

/**
 * Safely flushes pending stdout and stderr stream buffers before terminating the Node.js process.
 *
 * @remarks
 * Node.js stdout/stderr streams are asynchronous and buffered when redirected to non-TTY descriptors (e.g. files/pipes).
 * Immediate calls to `process.exit()` can discard buffered log output. `flushAndExit` yields the event loop,
 * requests stream buffer draining, applies an unreferenced safety timeout, and then exits.
 *
 * @param code - Process exit status code.
 * @param fallbackMs - Maximum duration in milliseconds to wait for stream draining. Defaults to 1000ms.
 */
export async function flushAndExit(code: number, fallbackMs = 1000): Promise<void> {
  process.exitCode = code;

  // Yield to allow Winston transport macrotasks to write into stdout/stderr buffers
  await new Promise((resolve) => {
    setImmediate(resolve);
  });

  await new Promise<void>((resolve) => {
    let pending = 2;
    let resolved = false;

    const done = () => {
      pending -= 1;
      if (pending <= 0 && !resolved) {
        resolved = true;
        resolve();
      }
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    }, fallbackMs);
    timer.unref();

    if (process.stdout.writableLength === 0) {
      done();
    } else {
      process.stdout.write('', () => {
        done();
      });
    }

    if (process.stderr.writableLength === 0) {
      done();
    } else {
      process.stderr.write('', () => {
        done();
      });
    }
  });

  process.exit(code);
}

/**
 * Registers process-level fatal exception and rejection listeners that log errors with Java-style call stacks and flush streams before exiting.
 *
 * @param logger - Application logger instance to record fatal errors with. Defaults to {@link defaultLogger}.
 */
export function registerFatalProcessHandlers(logger: AppLogger = defaultLogger): void {
  process.on('uncaughtException', (err: unknown) => {
    logger.error('Uncaught Exception:', { error: err });
    void flushAndExit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled Promise Rejection:', { error: reason });
    void flushAndExit(1);
  });
}

if (isMainModule()) {
  registerFatalProcessHandlers(defaultLogger);

  startServer({ bindSignals: true }).catch(async (err: unknown) => {
    if (err && typeof err === 'object' && loggedStartupErrors.has(err)) {
      // Binding failure was already logged by startServer with ServerBinding decision and stack trace
    } else {
      defaultLogger.error('[server] Fatal server startup error:', { error: err });
    }
    await flushAndExit(1);
  });
}
