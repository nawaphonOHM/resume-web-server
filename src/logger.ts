/**
 * Centralized Application Logging Module using Winston.
 *
 * Provides structured decision telemetry, Java-style error formatting with cause chains,
 * configurable log levels, and injectable `AppLogger` interfaces for HTTP server observability.
 *
 * @packageDocumentation
 */

import process from 'node:process';
import winston from 'winston';

/**
 * Configures V8's stack trace frame limit to ensure complete, un-truncated call stacks.
 *
 * @remarks
 * By default, V8 / Node.js limits captured stack trace depth to 10 frames (`Error.stackTraceLimit = 10`),
 * which truncates deep diagnostic call stacks in complex asynchronous pipelines.
 * Setting this property globally to `Infinity` (or a positive integer from `process.env.STACK_TRACE_LIMIT`)
 * satisfies the architectural requirement for full diagnostic call stacks.
 * Note: Setting this globally affects all Error instances constructed within the Node.js process
 * and carries negligible memory and performance overhead during standard operation.
 */
export function configureStackTraceLimit(): void {
  const envLimit = process.env['STACK_TRACE_LIMIT'];
  if (envLimit !== undefined) {
    const parsed = Number.parseInt(envLimit, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      Error.stackTraceLimit = parsed;
      return;
    }
  }
  Error.stackTraceLimit = Number.POSITIVE_INFINITY;
}

// Initialize stack trace limit at module load time to guarantee un-truncated stack traces across all application components
configureStackTraceLimit();

/**
 * Internal Symbol used to securely identify decision log entries without collision or spoofing.
 */
export const DECISION_SYMBOL = Symbol.for('resume_web_server.isDecision');

/**
 * Marker set only by {@link formatJavaStyleError} on records whose `callStack` / `errorDetail`
 * were generated from a real error, distinguishing them from caller-supplied metadata.
 */
export const GENERATED_STACK_SYMBOL = Symbol.for('resume_web_server.generatedStack');

/**
 * Supported logging severity levels matching standard Winston levels.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'debug';

/**
 * Valid log level set for runtime validation.
 */
export const VALID_LOG_LEVELS = new Set<LogLevel>(['error', 'warn', 'info', 'http', 'debug']);

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
 * Safely converts an unknown value to a string representation without returning `[object Object]`.
 *
 * @param value - Any value.
 * @returns Safe string representation.
 */
export function safeStringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message.length > 0 ? value.message : value.name;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[Unserializable Object]';
    }
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  return value === undefined ? 'undefined' : 'null';
}

/**
 * Checks whether a value represents an error (Error instance, error-like object, non-empty error string, or error object).
 * Returns false for falsy values, numbers, and boolean values like `false` or `0`.
 *
 * @param val - Value to check.
 * @returns True if value is an error or potential error payload.
 */
export function isPotentialError(val: unknown): boolean {
  if (val === null || val === undefined || val === false || val === 0 || val === '') {
    return false;
  }
  if (val instanceof Error || isErrorObject(val)) {
    return true;
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    return true;
  }
  if (typeof val === 'object' && !Array.isArray(val)) {
    return true;
  }
  return false;
}

/**
 * Determines whether a value is an Error instance or cross-realm Error object with a stack trace.
 *
 * @param val - Value to check.
 * @returns True if value is an Error or Error-like object.
 */
export function isErrorObject(val: unknown): boolean {
  if (val instanceof Error) {
    return true;
  }
  if (typeof val === 'object' && val !== null) {
    if (Object.prototype.toString.call(val) === '[object Error]') {
      return true;
    }
    const rec = val as Record<string, unknown>;
    if (
      typeof rec['stack'] === 'string' &&
      /\n\s+at\s+/.test(rec['stack']) &&
      (typeof rec['message'] === 'string' || typeof rec['name'] === 'string')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Safely extracts a concise, sanitized message from an unknown error or object without dumping sensitive contents.
 *
 * @param err - Unknown error or object.
 * @param visited - Set tracking visited objects to prevent circular loops.
 * @returns Safe string message.
 */
export function sanitizeErrorMessage(err: unknown, visited = new Set<unknown>()): string {
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return String(err);
  }
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  if (typeof err === 'object' && err !== null) {
    if (visited.has(err)) {
      return '[Circular]';
    }
    visited.add(err);

    const obj = err as Record<string, unknown>;
    if (typeof obj['message'] === 'string' && obj['message'].length > 0) {
      return obj['message'];
    }
    const diag = sanitizeDiagnosticValue(obj) as Record<string, unknown>;
    const diagKeys = Object.keys(diag);
    if (diagKeys.length > 0) {
      try {
        return JSON.stringify(diag);
      } catch {
        // Fallback to placeholder
      }
    }
    const ownKeys = Object.keys(obj);
    if (ownKeys.length > 0) {
      return `[object with keys: ${ownKeys.join(', ')}]`;
    }
    return '[Object]';
  }
  if (typeof err === 'symbol') {
    return err.toString();
  }
  return err === undefined ? 'undefined' : 'null';
}

/**
 * Recursively formats an error and its nested cause chain (ES2022 `Error.cause`) in Java-style stack trace format.
 * Includes loop detection for circular error causes.
 *
 * @param err - The error object, string, or unknown value to format.
 * @param visited - Set tracking visited error instances to prevent infinite loops on circular causes.
 * @returns Complete Java-style stack trace string with `Caused by:` prefixes for nested causes.
 */
export function formatJavaStyleStackTrace(err: unknown, visited = new Set<unknown>()): string {
  if (err === null || err === undefined) {
    return 'Error: Unknown error';
  }

  if (visited.has(err)) {
    const errorMsg =
      typeof err === 'object' && 'message' in err && typeof err.message === 'string'
        ? err.message
        : sanitizeErrorMessage(err);
    return `[Circular: ${escapeForConsole(errorMsg)}]`;
  }
  visited.add(err);

  let name: string;
  let message: string;
  let rawStack: string;

  if (err instanceof Error) {
    name = typeof err.name === 'string' && err.name.length > 0 ? err.name : 'Error';
    message = typeof err.message === 'string' ? err.message : '';
    rawStack = typeof err.stack === 'string' ? err.stack : '';
  } else if (typeof err === 'object') {
    const errorObj = err as { name?: unknown; message?: unknown; stack?: unknown };
    name = typeof errorObj.name === 'string' && errorObj.name.length > 0 ? errorObj.name : 'Error';
    message = typeof errorObj.message === 'string' ? errorObj.message : sanitizeErrorMessage(err);
    rawStack = typeof errorObj.stack === 'string' ? errorObj.stack : '';
  } else {
    name = 'Error';
    message = sanitizeErrorMessage(err);
    rawStack = '';
  }

  const header =
    message.length > 0
      ? `${escapeForConsole(name)}: ${escapeForConsole(message)}`
      : escapeForConsole(name);

  const frameLines: string[] = [];
  if (rawStack.length > 0) {
    const lines = rawStack.split(/\r?\n/);
    for (const line of lines) {
      if (/^[ \t]+at\s+/.test(line)) {
        const frameMatch = /^([ \t]*)(.*)$/.exec(line);
        if (frameMatch) {
          const [, indent, content] = frameMatch;
          frameLines.push(indent + escapeForConsole(content));
        } else {
          frameLines.push(escapeForConsole(line));
        }
      }
    }
  }

  let trace = frameLines.length > 0 ? `${header}\n${frameLines.join('\n')}` : header;

  // Handle cause chain (ES2022 Error.cause)
  if (typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) {
      if (visited.has(cause)) {
        const causeMsg =
          typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string'
            ? cause.message
            : sanitizeErrorMessage(cause);
        trace += `\nCaused by: [Circular: ${escapeForConsole(causeMsg)}]`;
      } else {
        const causeTrace = formatJavaStyleStackTrace(cause, visited);
        trace += `\nCaused by: ${causeTrace}`;
      }
    }
  }

  return trace;
}

/**
 * Allow-list of diagnostic error fields safe to include in logs.
 * Secrets such as `apiKey`, `accessToken`, `Authorization`, and nested `response`/`config`
 * objects are excluded by omission rather than a denylist of exact key names.
 */
const DIAGNOSTIC_ERROR_KEYS = new Set([
  'code',
  'status',
  'statuscode',
  'errno',
  'syscall',
  'errors',
  'reason',
]);

/**
 * Serialized marker identifying authentic decision log records in JSON output.
 */
export const DECISION_LOG_TYPE = 'decision';

function isDiagnosticErrorKey(key: string): boolean {
  return DIAGNOSTIC_ERROR_KEYS.has(key.toLowerCase());
}

/**
 * Recursively copies only allow-listed diagnostic fields from nested error metadata.
 */
function sanitizeDiagnosticValue(value: unknown, visited = new Set<unknown>()): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (visited.has(value)) {
    return '[Circular]';
  }
  visited.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, visited));
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      const lower = k.toLowerCase();
      if (lower === 'name' || lower === 'message' || isDiagnosticErrorKey(k)) {
        cleaned[k] = sanitizeDiagnosticValue(v, visited);
      }
    }
    return cleaned;
  }
  return sanitizeErrorMessage(value, visited);
}

function formatDiagnosticValue(value: unknown): string {
  const sanitized = sanitizeDiagnosticValue(value);
  if (typeof sanitized === 'string') {
    return sanitized.length > 80 ? `${sanitized.slice(0, 77)}...` : sanitized;
  }
  if (
    typeof sanitized === 'number' ||
    typeof sanitized === 'boolean' ||
    typeof sanitized === 'bigint'
  ) {
    return String(sanitized);
  }
  if (typeof sanitized === 'object' && sanitized !== null) {
    try {
      const json = JSON.stringify(sanitized);
      return json.length > 80 ? `${json.slice(0, 77)}...` : json;
    } catch {
      return '[Object]';
    }
  }
  return safeStringify(sanitized);
}

/**
 * Replaces a raw Error (or error-like value) with a sanitized summary that is safe to serialize.
 * Retains only `name`, `message`, and allow-listed diagnostic fields.
 */
export function sanitizeErrorForLog(
  err: unknown,
  visited = new Set<unknown>(),
): Record<string, unknown> {
  if (err === null || err === undefined) {
    return { name: 'Error', message: 'Unknown error' };
  }
  if (visited.has(err)) {
    return { name: 'Error', message: '[Circular]' };
  }
  visited.add(err);

  if (typeof err === 'object') {
    const errorObj = err as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    if (typeof errorObj['name'] === 'string') {
      summary['name'] = errorObj['name'];
    } else {
      summary['name'] = 'Error';
    }
    if (typeof errorObj['message'] === 'string') {
      summary['message'] = errorObj['message'];
    } else {
      summary['message'] = sanitizeErrorMessage(err);
    }
    for (const [key, value] of Object.entries(errorObj)) {
      if (isDiagnosticErrorKey(key)) {
        summary[key] = sanitizeDiagnosticValue(value, visited);
      }
    }
    return summary;
  }
  if (typeof err === 'string') {
    return { name: 'Error', message: err };
  }
  return { name: 'Error', message: sanitizeErrorMessage(err) };
}

/**
 * Recursively inspects a value (object or array) and replaces any Error or Error-like objects with sanitized summaries.
 * Retains benign metadata intact while protecting against deep credential leaks.
 */
export function sanitizeAllErrorsInValue(value: unknown, visited = new Set<unknown>()): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'symbol'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  if (visited.has(value)) {
    return '[Circular]';
  }

  if (value instanceof Error || isErrorObject(value)) {
    return sanitizeErrorForLog(value, visited);
  }

  visited.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAllErrorsInValue(item, visited));
  }

  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      result[k] = sanitizeAllErrorsInValue(v, visited);
    }
    return result;
  }

  return safeStringify(value);
}

/**
 * Formats the summary line of an error including diagnostic properties (e.g. `ErrorName: error message (code: 503)`).
 * Bounded to prevent sensitive credentials or bulky socket/response objects from leaking.
 *
 * @param err - The error object, string, or unknown value.
 * @returns Concise error detail string.
 */
export function formatErrorDetail(err: unknown): string {
  if (err instanceof Error || (typeof err === 'object' && err !== null)) {
    const errorObj = err as Record<string, unknown>;
    const name = typeof errorObj['name'] === 'string' ? errorObj['name'] : 'Error';
    const message =
      typeof errorObj['message'] === 'string' ? errorObj['message'] : sanitizeErrorMessage(err);
    const extraEntries = Object.entries(errorObj).filter(([key]) => isDiagnosticErrorKey(key));
    if (extraEntries.length > 0) {
      const extraDetails = extraEntries
        .map(([k, v]) => `${k}: ${formatDiagnosticValue(v)}`)
        .join(', ');
      return extraDetails.length > 0
        ? `${name}: ${message} (${extraDetails})`
        : `${name}: ${message}`;
    }
    return `${name}: ${message}`;
  }
  if (typeof err === 'string') {
    return `Error: ${err}`;
  }
  return `Error: ${sanitizeErrorMessage(err)}`;
}

/**
 * Winston format that populates `errorDetail` and `callStack` on the log info object.
 */
export const formatJavaStyleError = winston.format((info) => {
  let foundError: unknown = null;
  const isDecision = info[DECISION_SYMBOL as unknown as keyof typeof info] === true;

  // Reserve `callStack` / `errorDetail` for values generated by this formatter. Caller-supplied
  // metadata using those keys is untrusted: rename it so that its newlines can never be rendered
  // as authentic stack structure.
  if (info[GENERATED_STACK_SYMBOL as unknown as keyof typeof info] !== true) {
    if (info['callStack'] !== undefined) {
      info['userCallStack'] = info['callStack'];
      delete info['callStack'];
    }
    if (info['errorDetail'] !== undefined) {
      info['userErrorDetail'] = info['errorDetail'];
      delete info['errorDetail'];
    }
  }

  if (isDecision) {
    if (
      info['error'] !== undefined &&
      info['error'] !== null &&
      (info['error'] instanceof Error || isErrorObject(info['error']))
    ) {
      foundError = info['error'];
    } else if (
      info['err'] !== undefined &&
      info['err'] !== null &&
      (info['err'] instanceof Error || isErrorObject(info['err']))
    ) {
      foundError = info['err'];
    }
  } else {
    if (info['error'] !== undefined && isPotentialError(info['error'])) {
      foundError = info['error'];
    } else if (info['err'] !== undefined && isPotentialError(info['err'])) {
      foundError = info['err'];
    } else {
      const splat = info[Symbol.for('splat') as unknown as keyof typeof info];
      if (Array.isArray(splat)) {
        for (const item of splat) {
          if (isErrorObject(item)) {
            foundError = item;
            break;
          }
        }
      }
    }
  }

  if (foundError !== null) {
    info['errorDetail'] = formatErrorDetail(foundError);
    let fullStack = formatJavaStyleStackTrace(foundError);

    const additionalErrors = info['additionalErrors'];
    if (Array.isArray(additionalErrors) && additionalErrors.length > 0) {
      for (const extra of additionalErrors) {
        if (extra !== null && extra !== undefined) {
          fullStack += `\n\nAdditional Error:\n${formatJavaStyleStackTrace(extra)}`;
        }
      }
    }

    info['callStack'] = fullStack;
    (info as Record<symbol, unknown>)[GENERATED_STACK_SYMBOL] = true;

    if (info['error'] !== undefined) {
      info['error'] = sanitizeErrorForLog(info['error']);
    }
    if (info['err'] !== undefined) {
      info['err'] = sanitizeErrorForLog(info['err']);
    }
  }

  // Deeply sanitize all fields across info to prevent any nested Error objects from leaking raw fields in JSON mode
  for (const [key, value] of Object.entries(info)) {
    if (key === 'errorDetail' || key === 'callStack') {
      continue;
    }
    info[key] = sanitizeAllErrorsInValue(value);
  }

  return info;
});

/**
 * Winston format that handles structured decision telemetry payloads.
 */
export const formatDecision = winston.format((info) => {
  if (info[DECISION_SYMBOL as unknown as keyof typeof info] === true) {
    info['logType'] = DECISION_LOG_TYPE;
    if (typeof info.message !== 'string' || info.message.length === 0) {
      const action = safeStringify(info['action']);
      const choice = safeStringify(info['choice']);
      const reason = safeStringify(info['reason']);
      info.message = `Decision [${action}] | Choice: ${choice} | Reason: ${reason}`;
    }
  }
  return info;
});

const IGNORED_CONSOLE_KEYS = new Set([
  'level',
  'message',
  'timestamp',
  'errorDetail',
  'callStack',
  'error',
  'err',
  'splat',
  'logType',
  'additionalErrors',
]);

// eslint-disable-next-line no-control-regex -- control character range required to sanitize hostile log injection and ANSI terminal exploits
const CONTROL_CHAR_REGEX = /[\x00-\x1f\x7f\u2028\u2029]/g;

/**
 * Escapes control characters, ANSI escape sequences, line breaks, and raw control bytes in strings
 * to prevent terminal log injection, ANSI formatting exploits, or fake log line forgery.
 *
 * @param str - The raw untrusted string to escape.
 * @returns Escaped safe string for console logging.
 */
export function escapeForConsole(str: string): string {
  return str.replace(CONTROL_CHAR_REGEX, (char) => {
    switch (char) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      case '\v':
        return '\\v';
      case '\x1b':
        return '\\x1b';
      case '\0':
        return '\\0';
      default: {
        const code = char.charCodeAt(0);
        if (code <= 0xff) {
          return `\\x${code.toString(16).padStart(2, '0')}`;
        }
        return `\\u${code.toString(16).padStart(4, '0')}`;
      }
    }
  });
}

/**
 * Escapes control characters and ANSI sequences within a multi-line Java-style stack trace
 * while preserving standard newline line breaks and leading indentation spaces/tabs.
 *
 * @param callStack - Multi-line stack trace string.
 * @returns Escaped multi-line stack trace.
 */
export function escapeCallStack(callStack: string): string {
  return callStack
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([ \t]*)(.*)$/.exec(line);
      if (!match) {
        return escapeForConsole(line);
      }
      const [, indent, content] = match;
      return indent + escapeForConsole(content);
    })
    .join('\n');
}

/**
 * Winston format that generates clean, human-readable console output.
 */
export const formatConsoleOutput = winston.format.printf((info) => {
  const timestamp =
    typeof info['timestamp'] === 'string' ? info['timestamp'] : new Date().toISOString();
  const level = info.level;
  const rawMessage = typeof info.message === 'string' ? info.message : safeStringify(info.message);
  const message = escapeForConsole(rawMessage);

  const isDecision = info[DECISION_SYMBOL as unknown as keyof typeof info] === true;
  const metaParts: string[] = [];

  for (const [key, value] of Object.entries(info)) {
    if (IGNORED_CONSOLE_KEYS.has(key)) {
      if ((key === 'error' || key === 'err') && info['errorDetail'] === undefined) {
        // Allow benign non-error metadata (e.g. error: false, error: 0) or non-exception strings to be printed
      } else {
        continue;
      }
    }
    if (isDecision && (key === 'action' || key === 'choice' || key === 'reason')) {
      continue;
    }
    let displayKey = key;
    if (key === 'metaMessage') {
      displayKey = 'message';
    }
    const formattedKey = displayKey.charAt(0).toUpperCase() + displayKey.slice(1);
    const formattedVal = safeStringify(value);
    metaParts.push(`${escapeForConsole(formattedKey)}: ${escapeForConsole(formattedVal)}`);
  }

  let line = `${timestamp} [${level}]: ${message}`;
  if (metaParts.length > 0) {
    line += ` | ${metaParts.join(' | ')}`;
  }

  const hasGeneratedStack = (info as Record<symbol, unknown>)[GENERATED_STACK_SYMBOL] === true;

  if (hasGeneratedStack && typeof info['errorDetail'] === 'string') {
    line += `\nError Detail: ${escapeForConsole(info['errorDetail'])}`;
  }

  if (hasGeneratedStack && typeof info['callStack'] === 'string') {
    line += `\nCall Stack:\n${escapeCallStack(info['callStack'])}`;
  }

  return line;
});

/**
 * Implementation of {@link AppLogger} wrapping a Winston logger instance.
 */
export class WinstonAppLogger implements AppLogger {
  readonly #winston: winston.Logger;

  constructor(winstonLogger: winston.Logger) {
    this.#winston = winstonLogger;
  }

  /**
   * Access to the underlying Winston logger instance.
   */
  get winston(): winston.Logger {
    return this.#winston;
  }

  #processLogArgs(
    level: LogLevel,
    message: string | Error,
    meta: unknown[],
  ): { logMessage: string; payload: Record<string, unknown> } {
    let logMessage: string;
    let foundError: unknown = undefined;
    const additionalErrors: unknown[] = [];
    const mergedMeta: Record<string, unknown> = {};
    const extraMeta: unknown[] = [];

    if (message instanceof Error) {
      foundError = message;
      logMessage = message.message.length > 0 ? message.message : message.name;
    } else if (isErrorObject(message)) {
      foundError = message;
      const rec = message as unknown as Record<string, unknown>;
      const msg = typeof rec['message'] === 'string' ? rec['message'] : '';
      const name = typeof rec['name'] === 'string' ? rec['name'] : 'Error';
      logMessage = msg.length > 0 ? msg : name;
    } else {
      logMessage = typeof message === 'string' ? message : safeStringify(message);
    }

    for (const item of meta) {
      if (item instanceof Error || isErrorObject(item)) {
        if (!foundError) {
          foundError = item;
        } else {
          additionalErrors.push(item);
        }
      } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        const itemObj = item as Record<string, unknown>;
        for (const [k, v] of Object.entries(itemObj)) {
          if (k === 'message') {
            mergedMeta['metaMessage'] = v;
          } else {
            mergedMeta[k] = v;
          }
        }
      } else {
        extraMeta.push(item);
      }
    }

    if (!foundError) {
      if (mergedMeta['error'] !== undefined && isPotentialError(mergedMeta['error'])) {
        foundError = mergedMeta['error'];
      } else if (mergedMeta['err'] !== undefined && isPotentialError(mergedMeta['err'])) {
        foundError = mergedMeta['err'];
      }
    }

    if (additionalErrors.length > 0) {
      mergedMeta['additionalErrors'] = additionalErrors;
    }

    if (extraMeta.length > 0) {
      mergedMeta['meta'] = extraMeta.length === 1 ? extraMeta[0] : extraMeta;
    }

    // Ordinary logs cannot spoof the serialized decision marker.
    delete mergedMeta['logType'];

    if (foundError !== undefined) {
      if (
        mergedMeta['error'] !== undefined &&
        mergedMeta['error'] !== foundError &&
        !isErrorObject(mergedMeta['error'])
      ) {
        mergedMeta['errorContext'] = mergedMeta['error'];
      }
      if (
        mergedMeta['err'] !== undefined &&
        mergedMeta['err'] !== foundError &&
        !isErrorObject(mergedMeta['err'])
      ) {
        mergedMeta['errorContext'] = mergedMeta['err'];
        delete mergedMeta['err'];
      }
      mergedMeta['error'] = foundError;
    }

    return { logMessage, payload: mergedMeta };
  }

  #log(level: LogLevel, message: string | Error, ...meta: unknown[]): void {
    const { logMessage, payload } = this.#processLogArgs(level, message, meta);
    this.#winston.log(level, logMessage, payload);
  }

  info(message: string, ...meta: unknown[]): void {
    this.#log('info', message, ...meta);
  }

  warn(message: string | Error, ...meta: unknown[]): void {
    this.#log('warn', message, ...meta);
  }

  error(message: string | Error, ...meta: unknown[]): void {
    this.#log('error', message, ...meta);
  }

  http(message: string, ...meta: unknown[]): void {
    this.#log('http', message, ...meta);
  }

  debug(message: string, ...meta: unknown[]): void {
    this.#log('debug', message, ...meta);
  }

  decision(payload: DecisionLogPayload): void {
    const { action, choice, reason, level = 'info', ...meta } = payload;
    const cleanMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k === 'message') {
        cleanMeta['metaMessage'] = v;
      } else if (k !== 'logType') {
        cleanMeta[k] = v;
      }
    }
    const message = `Decision [${action}] | Choice: ${choice} | Reason: ${reason}`;
    const targetLevel: LogLevel = resolveLogLevel(level);
    this.#winston.log(targetLevel, message, {
      [DECISION_SYMBOL]: true,
      action,
      choice,
      reason,
      ...cleanMeta,
      logType: DECISION_LOG_TYPE,
    });
  }
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
  return 'info';
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
 * Logs a decision using either an {@link AppLogger}, a raw Winston Logger, or a compatible logger.
 *
 * @param targetLogger - Logger instance.
 * @param payload - Decision details.
 */
export function logDecision(
  targetLogger: AppLogger | winston.Logger | GenericLogger,
  payload: DecisionLogPayload,
): void {
  if ('decision' in targetLogger && typeof targetLogger.decision === 'function') {
    targetLogger.decision(payload);
  } else if ('log' in targetLogger && typeof targetLogger.log === 'function') {
    const { action, choice, reason, level = 'info', ...meta } = payload;
    const cleanMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k === 'message') {
        cleanMeta['metaMessage'] = v;
      } else if (k !== 'logType') {
        cleanMeta[k] = v;
      }
    }
    const message = `Decision [${action}] | Choice: ${choice} | Reason: ${reason}`;
    const targetLevel: LogLevel = resolveLogLevel(level);
    targetLogger.log(targetLevel, message, {
      [DECISION_SYMBOL]: true,
      action,
      choice,
      reason,
      ...cleanMeta,
      logType: DECISION_LOG_TYPE,
    });
  } else {
    const { action, choice, reason, level = 'info', ...meta } = payload;
    const message = `Decision [${action}] | Choice: ${choice} | Reason: ${reason}`;
    const targetLevel = resolveLogLevel(level);
    const extraArgs: unknown[] = [];
    if (meta['error'] !== undefined) {
      extraArgs.push(meta['error']);
    }

    if (targetLevel === 'error') {
      if (typeof targetLogger.error === 'function') {
        targetLogger.error(message, ...extraArgs);
      } else {
        targetLogger.info(`[ERROR] ${message}`, ...extraArgs);
      }
    } else if (targetLevel === 'warn') {
      if (typeof targetLogger.warn === 'function') {
        targetLogger.warn(message, ...extraArgs);
      } else {
        targetLogger.info(`[WARN] ${message}`, ...extraArgs);
      }
    } else if (targetLevel === 'debug') {
      if (typeof targetLogger.debug === 'function') {
        targetLogger.debug(message, ...extraArgs);
      }
    } else if (targetLevel === 'http') {
      if (typeof targetLogger.http === 'function') {
        targetLogger.http(message, ...extraArgs);
      }
    } else {
      targetLogger.info(message, ...extraArgs);
    }
  }
}

/**
 * Adapts any {@link GenericLogger} or {@link ServerLogger}-like object into a full {@link AppLogger}.
 * If the provided logger already implements {@link AppLogger}, it is returned as-is.
 *
 * @param candidateLogger - An optional logger instance to wrap or adapt.
 * @returns A fully conformant {@link AppLogger}.
 */
export function toAppLogger(candidateLogger?: GenericLogger | AppLogger): AppLogger {
  if (!candidateLogger) {
    return logger;
  }
  if ('decision' in candidateLogger && typeof candidateLogger.decision === 'function') {
    return candidateLogger as AppLogger;
  }

  return {
    info: (message: string, ...meta: unknown[]) => {
      candidateLogger.info(message, ...meta);
    },
    warn: (message: string | Error, ...meta: unknown[]) => {
      if (typeof candidateLogger.warn === 'function') {
        candidateLogger.warn(message, ...meta);
      } else {
        const text = message instanceof Error ? message.message : message;
        candidateLogger.info(`[WARN] ${text}`, ...meta);
      }
    },
    error: (message: string | Error, ...meta: unknown[]) => {
      if (typeof candidateLogger.error === 'function') {
        candidateLogger.error(message, ...meta);
      } else {
        const text = message instanceof Error ? message.message : message;
        candidateLogger.info(`[ERROR] ${text}`, ...meta);
      }
    },
    http: (message: string, ...meta: unknown[]) => {
      if (typeof candidateLogger.http === 'function') {
        candidateLogger.http(message, ...meta);
      }
    },
    debug: (message: string, ...meta: unknown[]) => {
      if (typeof candidateLogger.debug === 'function') {
        candidateLogger.debug(message, ...meta);
      }
    },
    decision: (payload: DecisionLogPayload) => {
      logDecision(candidateLogger, payload);
    },
  };
}

/**
 * Creates and configures an {@link AppLogger} backed by Winston.
 *
 * @param options - Optional logger configuration.
 * @returns An initialized {@link AppLogger} instance.
 */
export function createAppLogger(options: LoggerOptions = {}): AppLogger {
  const level: LogLevel =
    options.level !== undefined
      ? resolveLogLevel(options.level)
      : resolveLogLevel(process.env['LOG_LEVEL']);
  const silent = options.silent ?? false;
  const isJson = options.json ?? false;

  const transports =
    options.transports && options.transports.length > 0
      ? options.transports
      : [
          new winston.transports.Console({
            stderrLevels: ['error'],
          }),
        ];

  const winstonLogger = winston.createLogger({
    level,
    silent,
    defaultMeta: options.defaultMeta,
    format: winston.format.combine(
      winston.format.timestamp(),
      formatDecision(),
      formatJavaStyleError(),
      isJson ? winston.format.json() : formatConsoleOutput,
    ),
    transports,
  });

  return new WinstonAppLogger(winstonLogger);
}

/**
 * Default application logger singleton.
 */
export const logger: AppLogger = createAppLogger();

export default logger;
