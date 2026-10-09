/**
 * Adapter utilities for conforming arbitrary logger instances to AppLogger.
 *
 * @packageDocumentation
 */

import { defaultLogger } from '../default_logger.ts';
import { logDecision } from '../decision/decision_logger.ts';
import type { AppLogger, DecisionLogPayload, GenericLogger } from './logger_types.ts';

function extractMessageText(message: string | Error): string {
  return message instanceof Error ? message.message : message;
}

function adaptWarn(candidate: GenericLogger, message: string | Error, meta: unknown[]): void {
  if (typeof candidate.warn === 'function') {
    candidate.warn(message, ...meta);
  } else {
    candidate.info(`[WARN] ${extractMessageText(message)}`, ...meta);
  }
}

function adaptError(candidate: GenericLogger, message: string | Error, meta: unknown[]): void {
  if (typeof candidate.error === 'function') {
    candidate.error(message, ...meta);
  } else {
    candidate.info(`[ERROR] ${extractMessageText(message)}`, ...meta);
  }
}

function adaptHttp(candidate: GenericLogger, message: string, meta: unknown[]): void {
  if (typeof candidate.http === 'function') {
    candidate.http(message, ...meta);
  }
}

function adaptDebug(candidate: GenericLogger, message: string, meta: unknown[]): void {
  if (typeof candidate.debug === 'function') {
    candidate.debug(message, ...meta);
  }
}

class AdaptedLogger implements AppLogger {
  readonly #candidate: GenericLogger;

  public constructor(candidate: GenericLogger) {
    this.#candidate = candidate;
  }

  public info(msg: string, ...meta: unknown[]): void {
    this.#candidate.info(msg, ...meta);
  }

  public warn(msg: string | Error, ...meta: unknown[]): void {
    adaptWarn(this.#candidate, msg, meta);
  }

  public error(msg: string | Error, ...meta: unknown[]): void {
    adaptError(this.#candidate, msg, meta);
  }

  public http(msg: string, ...meta: unknown[]): void {
    adaptHttp(this.#candidate, msg, meta);
  }

  public debug(msg: string, ...meta: unknown[]): void {
    adaptDebug(this.#candidate, msg, meta);
  }

  public decision(payload: DecisionLogPayload): void {
    logDecision(this.#candidate, payload);
  }
}

function isAppLogger(candidate: GenericLogger | AppLogger): candidate is AppLogger {
  return 'decision' in candidate && typeof candidate.decision === 'function';
}

function resolveFallback(fallback?: AppLogger): AppLogger {
  return fallback ?? defaultLogger;
}

function adaptPresentLogger(candidate: GenericLogger | AppLogger): AppLogger {
  return isAppLogger(candidate) ? candidate : new AdaptedLogger(candidate);
}

/**
 * Normalizes an unknown or generic logger instance into an {@link AppLogger}.
 *
 * @param candidate - Candidate logger to normalize.
 * @param fallback - Optional fallback logger when candidate is absent.
 * @returns Conforming {@link AppLogger} instance.
 */
export function toAppLogger(
  candidate?: GenericLogger | AppLogger,
  fallback?: AppLogger,
): AppLogger {
  return candidate ? adaptPresentLogger(candidate) : resolveFallback(fallback);
}
