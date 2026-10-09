/**
 * Structured decision logging helpers for server bootstrap and socket binding.
 *
 * @packageDocumentation
 */

import { logDecision, type DecisionLogPayload } from '../logger/logger.ts';
import type { ServerConfig } from '../config/config.ts';
import type { ServerLogger } from './server_types.ts';

function makeBootstrapMeta(overrides: Partial<ServerConfig>, effectiveConfig: ServerConfig) {
  return { level: 'debug' as const, overrides, effectiveConfig };
}

function makeBootstrapPayload(
  overrides: Partial<ServerConfig>,
  cfg: ServerConfig,
): DecisionLogPayload {
  const meta = makeBootstrapMeta(overrides, cfg);
  const reason = 'Configuration overrides supplied via StartServerOptions';
  return { action: 'ServerBootstrap', choice: 'apply explicit config overrides', reason, ...meta };
}

/**
 * Logs a decision when explicit configuration overrides are applied at startup.
 */
export function logBootstrapOverrides(
  logger: ServerLogger,
  overrides: Partial<ServerConfig>,
  effectiveConfig: ServerConfig,
): void {
  logDecision(logger, makeBootstrapPayload(overrides, effectiveConfig));
}

function makeBindingFailurePayload(cfg: ServerConfig, err: Error): DecisionLogPayload {
  return {
    action: 'ServerBinding',
    choice: 'binding failure',
    reason: `Server failed to bind to ${cfg.host}:${String(cfg.port)}: ${err.message}`,
    level: 'error',
    error: err,
  };
}

/**
 * Logs a decision when TCP port binding fails.
 */
export function logBindingFailure(
  logger: ServerLogger,
  effectiveConfig: ServerConfig,
  err: Error,
): void {
  logDecision(logger, makeBindingFailurePayload(effectiveConfig, err));
}

function makeSuccessDetails(
  ep: { readonly host: string; readonly port: number },
  cfg: ServerConfig,
) {
  const { port, host } = ep;
  const { bucketName, prefix } = cfg;
  return { level: 'info' as const, port, host, bucketName, prefix };
}

function makeBindingSuccessPayload(
  ep: { readonly host: string; readonly port: number },
  cfg: ServerConfig,
): DecisionLogPayload {
  const choice = `bound to http://${ep.host}:${String(ep.port)}`;
  const reason =
    'Server successfully bound to network interface and listening for incoming connections';
  return { action: 'ServerBinding', choice, reason, ...makeSuccessDetails(ep, cfg) };
}

/**
 * Logs a decision when TCP port binding succeeds.
 */
export function logBindingSuccess(
  logger: ServerLogger,
  endpoint: { readonly host: string; readonly port: number },
  effectiveConfig: ServerConfig,
): void {
  logDecision(logger, makeBindingSuccessPayload(endpoint, effectiveConfig));
}
