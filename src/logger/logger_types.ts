/**
 * Type definitions, symbols, and constants for the logging subsystem.
 *
 * @packageDocumentation
 */

import type winston from 'winston';

/**
 * Standard decimal radix for parseInt.
 */
export const RADIX_DECIMAL = 10;

/**
 * Standard hexadecimal radix for formatting character codes.
 */
export const RADIX_HEX = 16;

/**
 * Two-character hex padding.
 */
export const HEX_PAD_TWO = 2;

/**
 * Four-character hex padding.
 */
export const HEX_PAD_FOUR = 4;

/**
 * Maximum single-byte character code limit.
 */
export const BYTE_MAX = 0xff;

/**
 * Maximum character limit for diagnostic property strings before truncation.
 */
export const MAX_DIAGNOSTIC_STRING_LENGTH = 80;

/**
 * Truncation slice length for diagnostic property strings.
 */
export const DIAGNOSTIC_TRUNCATE_LENGTH = 77;

/**
 * Internal Symbol used to securely identify decision log entries without collision or spoofing.
 */
export const DECISION_SYMBOL = Symbol.for('resume_web_server.isDecision');

/**
 * Marker set only by `formatJavaStyleError` on records whose `callStack` / `errorDetail`
 * were generated from a real error, distinguishing them from caller-supplied metadata.
 */
export const GENERATED_STACK_SYMBOL = Symbol.for('resume_web_server.generatedStack');

/**
 * Serialized marker identifying authentic decision log records in JSON output.
 */
export const DECISION_LOG_TYPE = 'decision';

/**
 * Supported logging severity levels matching standard Winston levels.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'debug';

/**
 * Valid log level set for runtime validation.
 */
export const VALID_LOG_LEVELS = new Set<LogLevel>(['error', 'warn', 'info', 'http', 'debug']);

/**
 * Default fallback log level when unspecified or invalid.
 */
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/**
 * Standardized telemetry payload for recording architectural and routing decisions.
 */
export interface DecisionLogPayload {
  /**
   * The subsystem or action component making the decision (e.g. 'Router', 'Config', 'Storage').
   */
  readonly action: string;

  /**
   * The specific choice or branch selected (e.g. 'SPA fallback (index.html)', 'port: 8080').
   */
  readonly choice: string;

  /**
   * The underlying operational or business rationale for the selected choice.
   */
  readonly reason: string;

  /**
   * Optional logging severity level for the decision (defaults to 'info').
   */
  readonly level?: LogLevel;

  /**
   * Additional contextual metadata associated with the decision.
   */
  readonly [key: string]: unknown;
}

/**
 * Application logger contract supporting standard severity levels and structured decision logging.
 */
export interface AppLogger {
  /**
   * Logs an informational message with optional metadata.
   */
  info(message: string, ...meta: unknown[]): void;

  /**
   * Logs a warning message or Error with optional metadata.
   */
  warn(message: string | Error, ...meta: unknown[]): void;

  /**
   * Logs an error message or Error object with optional metadata.
   */
  error(message: string | Error, ...meta: unknown[]): void;

  /**
   * Logs an HTTP-level message with optional metadata.
   */
  http(message: string, ...meta: unknown[]): void;

  /**
   * Logs a debug diagnostic message with optional metadata.
   */
  debug(message: string, ...meta: unknown[]): void;

  /**
   * Logs an operational decision with explicit action, choice, reason, and context.
   */
  decision(payload: DecisionLogPayload): void;
}

/**
 * Configuration options for initializing an {@link AppLogger}.
 */
export interface LoggerOptions {
  /**
   * Minimum log level threshold to emit. Defaults to `process.env.LOG_LEVEL` or `'info'`.
   */
  readonly level?: LogLevel;

  /**
   * When true, disables all log output (ideal for automated test suites).
   */
  readonly silent?: boolean;

  /**
   * When true, formats logs as JSON instead of human-readable text.
   */
  readonly json?: boolean;

  /**
   * Default metadata attributes attached to every log entry.
   */
  readonly defaultMeta?: Record<string, unknown>;

  /**
   * Custom Winston transports (optional; defaults to standard Console transport).
   */
  readonly transports?: winston.transport[];
}

/**
 * Generic minimal logger contract acceptable by {@link logDecision}.
 */
export interface GenericLogger {
  info(message: string, ...args: unknown[]): void;
  error?(message: string | Error, ...args: unknown[]): void;
  warn?(message: string | Error, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
  http?(message: string, ...args: unknown[]): void;
  decision?(payload: DecisionLogPayload): void;
}

/**
 * Normalizes and validates a candidate log level string, defaulting safely to `'info'`.
 *
 * @param level - Log level candidate.
 * @returns Validated LogLevel.
 */
export function resolveLogLevel(level?: string): LogLevel {
  if (typeof level === 'string') {
    const normalized = level.trim().toLowerCase() as LogLevel;
    if (VALID_LOG_LEVELS.has(normalized)) {
      return normalized;
    }
  }
  return DEFAULT_LOG_LEVEL;
}
