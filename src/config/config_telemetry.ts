/**
 * Structured telemetry logging for server configuration decisions.
 *
 * @packageDocumentation
 */

import type { AppLogger } from '../logger/logger.ts';
import { DEFAULT_HOST, DEFAULT_PORT } from './config_types.ts';

/**
 * Intermediate decision payload structure for configuration telemetry logging.
 */
export interface DecisionInfo {
  readonly choice: string;
  readonly reason: string;
  readonly variable: string;
  readonly resolved: string | number;
}

/**
 * Emits a structured configuration decision log to the provided logger.
 *
 * @param logger - Target application logger.
 * @param info - Decision description info.
 */
export function emitDecision(logger: AppLogger, info: DecisionInfo): void {
  const meta = { variable: info.variable, resolved: info.resolved };
  logger.decision({
    action: 'Config',
    choice: info.choice,
    reason: info.reason,
    level: 'debug' as const,
    ...meta,
  });
}

function getPortUnsetReason(rawPort: string | undefined, port: number): string {
  const status = rawPort === undefined ? 'not set' : 'is empty';
  const suffix =
    port === DEFAULT_PORT
      ? `falling back to DEFAULT_PORT (${String(DEFAULT_PORT)})`
      : `resolved to ${String(port)} via validator`;
  return `PORT environment variable ${status}, ${suffix}`;
}

function getPortSetReason(rawPort: string, port: number): string {
  if (port === DEFAULT_PORT && rawPort.trim() !== String(DEFAULT_PORT)) {
    return `PORT environment variable value '${rawPort}' is invalid, falling back to DEFAULT_PORT (${String(DEFAULT_PORT)})`;
  }
  return 'Resolved from PORT environment variable';
}

function getPortReason(rawPort: string | undefined, port: number): string {
  if (rawPort === undefined || rawPort.trim() === '') {
    return getPortUnsetReason(rawPort, port);
  }
  return getPortSetReason(rawPort, port);
}

function makePortDecision(rawPort: string | undefined, port: number): DecisionInfo {
  return {
    choice: `port: ${String(port)}`,
    reason: getPortReason(rawPort, port),
    variable: 'PORT',
    resolved: port,
  };
}

/**
 * Logs the decision payload for resolving the `PORT` configuration parameter.
 *
 * @param logger - Optional application logger.
 * @param rawPort - Raw `PORT` environment variable value.
 * @param port - Resolved numeric port.
 */
export function logPortDecision(
  logger: AppLogger | undefined,
  rawPort: string | undefined,
  port: number,
): void {
  if (logger) emitDecision(logger, makePortDecision(rawPort, port));
}

function getHostUnsetReason(rawHost: string | undefined, host: string): string {
  const status = rawHost === undefined ? 'not set' : 'is empty';
  const suffix =
    host === DEFAULT_HOST
      ? `falling back to DEFAULT_HOST ('${DEFAULT_HOST}')`
      : `resolved to '${host}' via validator`;
  return `HOST environment variable ${status}, ${suffix}`;
}

function getHostReason(rawHost: string | undefined, host: string): string {
  if (rawHost === undefined || rawHost.trim() === '') {
    return getHostUnsetReason(rawHost, host);
  }
  return 'Resolved from HOST environment variable';
}

function makeHostDecision(rawHost: string | undefined, host: string): DecisionInfo {
  return {
    choice: `host: '${host}'`,
    reason: getHostReason(rawHost, host),
    variable: 'HOST',
    resolved: host,
  };
}

/**
 * Logs the decision payload for resolving the `HOST` configuration parameter.
 *
 * @param logger - Optional application logger.
 * @param rawHost - Raw `HOST` environment variable value.
 * @param host - Resolved host string.
 */
export function logHostDecision(
  logger: AppLogger | undefined,
  rawHost: string | undefined,
  host: string,
): void {
  if (logger) emitDecision(logger, makeHostDecision(rawHost, host));
}
