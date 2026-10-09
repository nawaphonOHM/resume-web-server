/**
 * Cache policy resolver implementation.
 *
 * @packageDocumentation
 */

import type { AppLogger } from './logger/logger.ts';
import {
  type ICachePolicyResolver,
  type IAssetClassifier,
  CACHE_CONTROL_IMMUTABLE,
  CACHE_CONTROL_NO_CACHE,
} from './mime/mime_types.ts';
import { DefaultAssetClassifier } from './asset_classifier.ts';

function getCacheChoice(hashed: boolean): string {
  return hashed ? 'immutable (31536000s)' : 'no-cache (must-revalidate)';
}

function getCacheReason(filePath: string, hashed: boolean): string {
  if (hashed) {
    return `Asset '${filePath}' matched content-hashed filename pattern`;
  }
  return `Asset '${filePath}' is unhashed or mutable and requires origin revalidation`;
}

function makeCacheMeta(filePath: string, hashed: boolean, header: string) {
  return { level: 'debug' as const, filePath, isHashed: hashed, cacheControl: header };
}

function makeCachePayload(filePath: string, hashed: boolean, header: string) {
  const meta = makeCacheMeta(filePath, hashed, header);
  return {
    action: 'CachePolicy' as const,
    choice: getCacheChoice(hashed),
    reason: getCacheReason(filePath, hashed),
    ...meta,
  };
}

/**
 * Default implementation of {@link ICachePolicyResolver} applying immutable or revalidation caching policies.
 */
export class DefaultCachePolicyResolver implements ICachePolicyResolver {
  /**
   * The asset classifier used to check whether assets are content-hashed.
   */
  private readonly assetClassifier: IAssetClassifier;

  /**
   * Optional injected application logger for recording cache policy decisions.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `DefaultCachePolicyResolver`.
   *
   * @param assetClassifier - Injected asset classifier instance. Defaults to {@link DefaultAssetClassifier}.
   * @param logger - Optional injected application logger.
   */
  public constructor(
    assetClassifier: IAssetClassifier = new DefaultAssetClassifier(),
    logger?: AppLogger,
  ) {
    this.assetClassifier = assetClassifier;
    this.logger = logger;
  }

  private logCacheDecision(filePath: string, hashed: boolean, header: string): void {
    if (this.logger) this.logger.decision(makeCachePayload(filePath, hashed, header));
  }

  /**
   * Computes the appropriate HTTP `Cache-Control` header value for a given file path.
   *
   * @param filePath - The file path or filename to determine cache policy for.
   * @param isHashed - Optional precomputed boolean indicating if the asset is hashed.
   * @returns The HTTP `Cache-Control` header string directive.
   */
  public getCacheControlHeader(filePath: string, isHashed?: boolean): string {
    const hashed = isHashed ?? this.assetClassifier.isHashedAsset(filePath);
    const header = hashed ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_NO_CACHE;
    this.logCacheDecision(filePath, hashed, header);
    return header;
  }
}
