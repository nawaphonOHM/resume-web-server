/**
 * Asset streaming handlers for static files and SPA fallback routing.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import { HTTP_STATUS_BAD_GATEWAY } from '../http/http_status_codes.ts';
import type { ResolvedRouterDependencies } from './router_deps_resolver.ts';
import { logSpaFallbackDecision, logStaticAssetDecision } from './router_telemetry.ts';

const SPA_FALLBACK_FILE = 'index.html';
const SPA_CONTENT_TYPE = 'text/html; charset=utf-8';

export interface AssetStreamParams {
  readonly path: string;
  readonly res: ServerResponse;
  readonly isHead: boolean;
}

interface AssetResolution {
  readonly contentType: string;
  readonly isHashed: boolean;
  readonly cacheControl: string;
}

function resolveAssetInfo(deps: ResolvedRouterDependencies, path: string): AssetResolution {
  const contentType = deps.mimeResolver.getMimeType(path);
  const isHashed = deps.assetClassifier.isHashedAsset(path);
  const cacheControl = deps.cachePolicyResolver.getCacheControlHeader(path, isHashed);
  return { contentType, isHashed, cacheControl };
}

function resolveAndLogAsset(
  deps: ResolvedRouterDependencies,
  p: AssetStreamParams,
): AssetResolution {
  const info = resolveAssetInfo(deps, p.path);
  logStaticAssetDecision(deps.logger, { path: p.path, isHead: p.isHead, ...info });
  return info;
}

export async function streamStaticAsset(
  deps: ResolvedRouterDependencies,
  p: AssetStreamParams,
): Promise<void> {
  const meta = resolveAndLogAsset(deps, p);
  await deps.storageService.streamFile(p.path, p.res, meta.contentType, meta.isHashed, p.isHead);
}

function makeFallbackArgs(
  p: AssetStreamParams,
): [string, ServerResponse, string, boolean, boolean, number] {
  return [SPA_FALLBACK_FILE, p.res, SPA_CONTENT_TYPE, false, p.isHead, HTTP_STATUS_BAD_GATEWAY];
}

export async function streamSpaFallback(
  deps: ResolvedRouterDependencies,
  p: AssetStreamParams,
): Promise<void> {
  logSpaFallbackDecision(deps.logger, p.path, p.isHead);
  await deps.storageService.streamFile(...makeFallbackArgs(p));
}

export async function dispatchAssetRoute(
  deps: ResolvedRouterDependencies,
  p: AssetStreamParams,
): Promise<void> {
  if (deps.assetClassifier.isStaticAsset(p.path)) {
    await streamStaticAsset(deps, p);
    return;
  }
  await streamSpaFallback(deps, p);
}
