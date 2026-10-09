/**
 * Request execution pipeline coordinating validation, health checks, and asset dispatch.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { dispatchAssetRoute, type AssetStreamParams } from './router_asset_streamer.ts';
import type { ResolvedRouterDependencies } from './router_deps_resolver.ts';
import { write500InternalServerError } from './router_error_responder.ts';
import {
  isHeadMethod,
  prepareRequest,
  validateAndExtractPath,
} from './router_request_validator.ts';
import { logUnhandledRouterError } from './router_telemetry.ts';

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly cleanPath: string;
  readonly isHead: boolean;
}

function toAssetParams(ctx: RouteContext): AssetStreamParams {
  return { path: ctx.cleanPath, res: ctx.res, isHead: ctx.isHead };
}

function onRouteError(
  logger: ResolvedRouterDependencies['logger'],
  req: IncomingMessage,
  res: ServerResponse,
  err: unknown,
): void {
  logUnhandledRouterError(logger, req, err);
  write500InternalServerError(res);
}

export async function executeRoute(
  deps: ResolvedRouterDependencies,
  ctx: RouteContext,
): Promise<void> {
  try {
    await dispatchAssetRoute(deps, toAssetParams(ctx));
  } catch (err) {
    onRouteError(deps.logger, ctx.req, ctx.res, err);
  }
}

async function dispatchIfHealthy(
  deps: ResolvedRouterDependencies,
  ctx: RouteContext,
): Promise<void> {
  if (!deps.healthCheckHandler.handle(ctx.cleanPath, ctx.res, ctx.isHead)) {
    await executeRoute(deps, ctx);
  }
}

async function processValidRequest(
  d: ResolvedRouterDependencies,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const cleanPath = validateAndExtractPath(d, req, res);
  if (cleanPath !== undefined) {
    await dispatchIfHealthy(d, { req, res, cleanPath, isHead: isHeadMethod(req) });
  }
}

export async function handleRequestPipeline(
  d: ResolvedRouterDependencies,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (prepareRequest(d, req, res)) {
    await processValidRequest(d, req, res);
  }
}
