/**
 * Dependency resolver for HTTP router constructing defaults and normalizing options.
 *
 * @packageDocumentation
 */

import { DefaultAssetClassifier } from '../asset_classifier.ts';
import { DefaultCachePolicyResolver } from '../cache_policy.ts';
import { defaultLogger } from '../default_logger.ts';
import type { AppLogger } from '../logger/logger_types.ts';
import { DefaultMimeTypeResolver } from '../mime/mime_resolver.ts';
import type {
  IAssetClassifier,
  ICachePolicyResolver,
  IMimeTypeResolver,
} from '../mime/mime_types.ts';
import { resolveHandlerDeps, type RouterHandlerDeps } from './router_deps_handlers.ts';
import type { RouterDependencies } from './router_types.ts';
import { createStorageService } from '../storage/storage.ts';
import type { StorageService } from '../storage/storage_types.ts';

export type ResolvedRouterDependencies = RouterHandlerDeps &
  RouterResolverDeps & {
    readonly storageService: StorageService;
    readonly logger: AppLogger;
  };

export interface RouterResolverDeps {
  readonly mimeResolver: IMimeTypeResolver;
  readonly assetClassifier: IAssetClassifier;
  readonly cachePolicyResolver: ICachePolicyResolver;
}

function hasStreamFile(obj: object): boolean {
  return 'streamFile' in obj && typeof (obj as { streamFile?: unknown }).streamFile === 'function';
}

export function isStorageService(candidate: unknown): candidate is StorageService {
  return typeof candidate === 'object' && candidate !== null && hasStreamFile(candidate);
}

function extractStorageAndDeps(
  arg?: StorageService | RouterDependencies,
  deps?: RouterDependencies,
): { storage?: StorageService; deps?: RouterDependencies } {
  if (isStorageService(arg)) return { storage: arg, deps };
  if (arg !== undefined) return { storage: arg.storageService, deps: arg };
  return {};
}

function getDepsStorage(deps: RouterDependencies | undefined): StorageService | undefined {
  return deps ? deps.storageService : undefined;
}

function resolveStorageService(
  storage: StorageService | undefined,
  deps: RouterDependencies | undefined,
  appLogger: AppLogger,
): StorageService {
  const chosen = storage ?? getDepsStorage(deps);
  return chosen ?? createStorageService(undefined, undefined, appLogger);
}

function getMimeResolver(d: RouterDependencies | undefined, log: AppLogger): IMimeTypeResolver {
  return d?.mimeResolver ?? new DefaultMimeTypeResolver(undefined, undefined, log);
}

function getAssetClassifier(d: RouterDependencies | undefined, log: AppLogger): IAssetClassifier {
  return d?.assetClassifier ?? new DefaultAssetClassifier(log);
}

export function resolveResolverDeps(
  d: RouterDependencies | undefined,
  log: AppLogger,
): RouterResolverDeps {
  const assetClassifier = getAssetClassifier(d, log);
  const mimeResolver = getMimeResolver(d, log);
  const cachePolicyResolver = new DefaultCachePolicyResolver(assetClassifier, log);
  return { mimeResolver, assetClassifier, cachePolicyResolver };
}

function resolveLogger(deps?: RouterDependencies): AppLogger {
  return deps ? (deps.logger ?? defaultLogger) : defaultLogger;
}

export function resolveRouterDependencies(
  storageOrDeps?: StorageService | RouterDependencies,
  deps?: RouterDependencies,
): ResolvedRouterDependencies {
  const ext = extractStorageAndDeps(storageOrDeps, deps);
  const log = resolveLogger(ext.deps);
  const storage = resolveStorageService(ext.storage, ext.deps, log);
  const rest = { ...resolveHandlerDeps(ext.deps, log), ...resolveResolverDeps(ext.deps, log) };
  return { storageService: storage, ...rest, logger: log };
}
