/**
 * Winston application logger implementation and factory.
 *
 * @packageDocumentation
 */

import process from 'node:process';
import winston from 'winston';
import { formatConsoleOutput } from './console/console_format.ts';
import { formatDecision } from './decision/decision_format.ts';
import { formatJavaStyleError } from './java/java_error_format.ts';
import { logDecision } from './decision/decision_logger.ts';
import { processLogArgs } from './log/log_args_processor.ts';
import {
  type AppLogger,
  type DecisionLogPayload,
  type LoggerOptions,
  type LogLevel,
  resolveLogLevel,
} from './logger/logger_types.ts';

/**
 * Implementation of {@link AppLogger} wrapping a Winston logger instance.
 */
export class WinstonAppLogger implements AppLogger {
  readonly #winston: winston.Logger;

  public constructor(winstonLogger: winston.Logger) {
    this.#winston = winstonLogger;
  }

  /**
   * Access to the underlying Winston logger instance.
   */
  public get winston(): winston.Logger {
    return this.#winston;
  }

  #log(level: LogLevel, message: string | Error, meta: unknown[]): void {
    const { logMessage, payload } = processLogArgs(message, meta);
    this.#winston.log(level, logMessage, payload);
  }

  public info(message: string, ...meta: unknown[]): void {
    this.#log('info', message, meta);
  }

  public warn(message: string | Error, ...meta: unknown[]): void {
    this.#log('warn', message, meta);
  }

  public error(message: string | Error, ...meta: unknown[]): void {
    this.#log('error', message, meta);
  }

  public http(message: string, ...meta: unknown[]): void {
    this.#log('http', message, meta);
  }

  public debug(message: string, ...meta: unknown[]): void {
    this.#log('debug', message, meta);
  }

  public decision(payload: DecisionLogPayload): void {
    logDecision(this.#winston, payload);
  }
}

function resolveEffectiveLevel(options: LoggerOptions): LogLevel {
  if (options.level !== undefined) {
    return resolveLogLevel(options.level);
  }
  return resolveLogLevel(process.env['LOG_LEVEL']);
}

function resolveTransports(options: LoggerOptions): winston.transport[] {
  if (options.transports && options.transports.length > 0) {
    return options.transports;
  }
  return [new winston.transports.Console({ stderrLevels: ['error'] })];
}

function buildWinstonFormat(isJson: boolean): winston.Logform.Format {
  const formatter = isJson ? winston.format.json() : formatConsoleOutput;
  return winston.format.combine(
    winston.format.timestamp(),
    formatDecision(),
    formatJavaStyleError(),
    formatter,
  );
}

function buildLoggerConfig(options: LoggerOptions): winston.LoggerOptions {
  return {
    level: resolveEffectiveLevel(options),
    silent: options.silent ?? false,
    defaultMeta: options.defaultMeta,
    format: buildWinstonFormat(Boolean(options.json)),
    transports: resolveTransports(options),
  };
}

/**
 * Creates and configures an {@link AppLogger} backed by Winston.
 *
 * @param options - Optional logger configuration.
 * @returns An initialized {@link AppLogger} instance.
 */
export function createAppLogger(options: LoggerOptions = {}): AppLogger {
  return new WinstonAppLogger(winston.createLogger(buildLoggerConfig(options)));
}
