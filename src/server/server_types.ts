/**
 * Server Lifecycle and Bootstrap Type Definitions.
 *
 * Defines domain contracts, options interfaces, and service abstractions
 * for HTTP server initialization, socket tracking, signal registration, and graceful shutdown.
 *
 * @packageDocumentation
 */

import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { ServerConfig } from '../config/config.ts';
import type { DecisionLogPayload } from '../logger/logger.ts';
import type { StorageService } from '../storage/storage.ts';

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
   */
  readonly port: number;

  /**
   * The actual host interface or IP address the server is bound to.
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
   */
  readonly config?: Partial<ServerConfig>;

  /**
   * Custom storage service implementation for serving assets.
   */
  readonly storageService?: StorageService;

  /**
   * Whether to automatically register process signal handlers (`SIGTERM` and `SIGINT`) for graceful shutdown.
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
   */
  readonly logger?: ServerLogger;
}

/**
 * Options controlling the behavior of the graceful server shutdown process.
 */
export interface ShutdownOptions {
  /**
   * Maximum duration in milliseconds to wait for active connections to drain before force-closing sockets.
   *
   * @defaultValue `8000`
   */
  readonly timeoutMs?: number;

  /**
   * Whether to terminate the Node.js process upon shutdown completion (`process.exit(0)` on success, `process.exit(1)` on error).
   *
   * @defaultValue `false`
   */
  readonly exitProcess?: boolean;

  /**
   * Logger used to record shutdown progress, warnings, and errors.
   */
  readonly logger?: ServerLogger;

  /**
   * Set of active client sockets to forcefully destroy if the shutdown timeout expires.
   */
  readonly sockets?: Set<Socket> | ReadonlySet<Socket>;

  /**
   * Optional callback invoked once the shutdown process completes, prior to promise settlement or process exit.
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
   */
  readonly logger?: ServerLogger;

  /**
   * Set of active client sockets override.
   */
  readonly sockets?: Set<Socket> | ReadonlySet<Socket>;
}

/**
 * Contract for tracking active HTTP client socket connections.
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
 * Contract for managing graceful server shutdown sequences.
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
 * Contract for registering and tearing down OS signal handlers.
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
 * Contract for initializing and launching the HTTP server.
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
