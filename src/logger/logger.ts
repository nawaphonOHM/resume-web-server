/**
 * Centralized Application Logging Module using Winston.
 *
 * Provides structured decision telemetry, Java-style error formatting with cause chains,
 * configurable log levels, and injectable `AppLogger` interfaces for HTTP server observability.
 *
 * @packageDocumentation
 */

export { configureStackTraceLimit } from '../stack/stack_trace.ts';
export {
  DECISION_SYMBOL,
  DECISION_LOG_TYPE,
  GENERATED_STACK_SYMBOL,
  type LogLevel,
  VALID_LOG_LEVELS,
  type DecisionLogPayload,
  type AppLogger,
  type LoggerOptions,
  resolveLogLevel,
  type GenericLogger,
} from './logger_types.ts';
export { escapeForConsole, escapeCallStack } from '../console/console_sanitizer.ts';
export { safeStringify } from '../safe_stringify.ts';
export { isErrorObject, isPotentialError } from '../error/error_inspector.ts';
export { sanitizeDiagnosticValue, formatDiagnosticValue } from '../diagnostic_sanitizer.ts';
export { sanitizeErrorMessage } from '../error/error_message_sanitizer.ts';
export { formatErrorDetail } from '../error/error_detail_formatter.ts';
export { sanitizeErrorForLog } from '../error/error_sanitizer.ts';
export { sanitizeAllErrorsInValue } from '../value_error_sanitizer.ts';
export { formatJavaStyleStackTrace } from '../java/java_stack_formatter.ts';
export { formatDecision } from '../decision/decision_format.ts';
export { formatJavaStyleError } from '../java/java_error_format.ts';
export { formatConsoleOutput } from '../console/console_format.ts';
export { WinstonAppLogger, createAppLogger } from '../app_logger.ts';
export { logDecision } from '../decision/decision_logger.ts';
export { toAppLogger } from './logger_adapter.ts';
export { defaultLogger as logger, defaultLogger as default } from '../default_logger.ts';
