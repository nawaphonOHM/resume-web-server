/**
 * Server socket binding and listening listener coordinator.
 *
 * @packageDocumentation
 */

import type { Server } from 'node:http';
import type { ServerConfig } from '../config/config.ts';
import { logBindingFailure, logBindingSuccess } from './server_bootstrap_telemetry.ts';
import type { ServerInstance, ServerLogger } from './server_types.ts';

/**
 * Weak set tracking binding errors that were already logged during startup.
 */
export const loggedStartupErrors = new WeakSet();

/**
 * Context for binding the server to port and host.
 */
export interface BindingContext {
  readonly server: Server;
  readonly instance: ServerInstance;
  readonly config: ServerConfig;
  readonly logger: ServerLogger;
  cleanupSignalHandlers?: () => void;
}

function cleanupSignals(ctx: BindingContext): void {
  if (ctx.cleanupSignalHandlers) {
    ctx.cleanupSignalHandlers();
    ctx.cleanupSignalHandlers = undefined;
  }
}

function handleBindingError(
  ctx: BindingContext,
  err: Error,
  reject: (reason: Error) => void,
): void {
  cleanupSignals(ctx);
  loggedStartupErrors.add(err);
  logBindingFailure(ctx.logger, ctx.config, err);
  reject(err);
}

function handleBindingSuccess(
  ctx: BindingContext,
  onError: (err: Error) => void,
  resolve: () => void,
): void {
  ctx.server.off('error', onError);
  logBindingSuccess(ctx.logger, ctx.instance, ctx.config);
  resolve();
}

function makeBindingErrorCallback(ctx: BindingContext, reject: (reason: Error) => void) {
  return (err: Error) => {
    handleBindingError(ctx, err, reject);
  };
}

function makeBindingSuccessCallback(
  ctx: BindingContext,
  onError: (err: Error) => void,
  resolve: () => void,
) {
  return () => {
    handleBindingSuccess(ctx, onError, resolve);
  };
}

function attachBindingListeners(
  ctx: BindingContext,
  resolve: () => void,
  reject: (reason: Error) => void,
): void {
  const onError = makeBindingErrorCallback(ctx, reject);
  const onListening = makeBindingSuccessCallback(ctx, onError, resolve);
  ctx.server.once('error', onError);
  ctx.server.listen(ctx.config.port, ctx.config.host, onListening);
}

/**
 * Binds the HTTP server to configured port and host, managing error and success event telemetry.
 */
export function listenServer(ctx: BindingContext): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    attachBindingListeners(ctx, resolve, reject);
  });
}
