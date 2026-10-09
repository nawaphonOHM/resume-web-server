/**
 * Server Lifecycle Constants.
 *
 * Provides named constants for default timeout durations, exit codes, and stream counts
 * to satisfy strict ESLint rules against magic numbers.
 *
 * @packageDocumentation
 */

/**
 * Default maximum duration in milliseconds to allow active connections to drain during graceful shutdown.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

/**
 * Default fallback timeout in milliseconds for flushing stdout and stderr before process exit.
 */
export const DEFAULT_FLUSH_FALLBACK_MS = 1000;

/**
 * Standard POSIX exit status code indicating clean process termination.
 */
export const EXIT_CODE_SUCCESS = 0;

/**
 * Standard POSIX exit status code indicating process termination due to an unhandled error.
 */
export const EXIT_CODE_ERROR = 1;

/**
 * Total number of standard output streams (stdout and stderr) to drain during process flush.
 */
export const DRAIN_STREAM_COUNT = 2;
