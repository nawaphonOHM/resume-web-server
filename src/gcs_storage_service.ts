/**
 * Google Cloud Storage implementation of {@link StorageService} adhering to SOLID principles.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import type { Storage, Bucket, File } from '@google-cloud/storage';
import { type ServerConfig, config as defaultConfig } from './config/config.ts';
import type { AppLogger } from './logger/logger_types.ts';
import {
  type ResolvedStorageDeps,
  type RestStorageDeps,
  resolveStorageDeps,
} from './storage/storage_deps_resolver.ts';
import { executeStreamDispatch, handleExistsError } from './storage/storage_service_helpers.ts';
import {
  type StreamDispatchContext,
  createStreamParams,
} from './storage/storage_stream_options.ts';
import type { StorageService, StorageServiceOptions } from './storage/storage_types.ts';

/**
 * Service providing asset existence checks and HTTP streaming from Google Cloud Storage.
 */
export class GcsStorageService implements StorageService {
  private readonly deps: ResolvedStorageDeps;
  private readonly bucket: Bucket;

  /**
   * Initializes a new instance of {@link GcsStorageService}.
   *
   * @param configOrOptions - Server configuration or options container.
   * @param storageClient - Optional injected GCS Storage client.
   * @param rest - Optional injected path resolver, ETag formatter, error classifier, or logger.
   */
  public constructor(
    configOrOptions: ServerConfig | StorageServiceOptions = defaultConfig,
    storageClient?: Storage,
    ...rest: RestStorageDeps
  ) {
    this.deps = resolveStorageDeps(configOrOptions, storageClient, ...rest);
    this.bucket = this.deps.storage.bucket(this.deps.config.bucketName);
  }

  /**
   * Resolves a relative object name into its fully-qualified bucket path.
   *
   * @param objectName - Relative asset filename or path.
   * @returns Fully-qualified object key within the GCS bucket.
   */
  public resolveObjectName(objectName: string): string {
    return this.deps.pathResolver.resolveObjectName(objectName);
  }

  /**
   * Determines whether an asset exists in the bucket directly or in a timestamped deployment folder.
   *
   * @param objectName - Relative asset filename to check.
   * @returns A promise resolving to `true` if the asset exists, or `false` if not found.
   */
  public async fileExists(objectName: string): Promise<boolean> {
    const fullPath = this.resolveObjectName(objectName);
    const res = await this.deps.objectLocator
      .locateFile(this.bucket, objectName, this.deps.config.prefix)
      .catch((err: unknown) => handleExistsError(err, fullPath, this.deps));
    return res !== null;
  }

  private createStreamContext(file: File, fullPath: string): StreamDispatchContext {
    return {
      file,
      fullPath,
      etagFormatter: this.deps.etagFormatter,
      errorClassifier: this.deps.errorClassifier,
      logger: this.deps.logger,
    };
  }

  /**
   * Streams a file from GCS to the HTTP response, using recursive search across timestamped folders if needed.
   *
   * @param name - Relative object name.
   * @param res - HTTP server response stream.
   * @param type - Content-Type MIME string.
   * @param rest - Flags for isHashed, isHead, and optional notFoundStatusCode.
   * @returns A promise resolving when streaming finishes or rejects on unhandled error.
   */
  public async streamFile(
    name: string,
    res: ServerResponse,
    type: string,
    ...rest: [boolean, boolean?, number?]
  ): Promise<void> {
    const p = createStreamParams(name, res, type, rest);
    const ctx = (f: File, fp: string) => this.createStreamContext(f, fp);
    await executeStreamDispatch(this.bucket, this.deps, p, ctx);
  }
}

/**
 * Factory function creating a configured {@link StorageService} instance.
 *
 * @param configOrOptions - Server configuration or options container.
 * @param storageClient - Optional injected GCS Storage client.
 * @param loggerInstance - Optional injected application logger.
 * @returns Configured {@link StorageService} instance.
 *
 * @example
 * ```ts
 * const storage = createStorageService({
 *   port: 8080,
 *   host: '0.0.0.0',
 *   bucketName: 'my-bucket',
 *   prefix: 'assets',
 * });
 * ```
 */
export function createStorageService(
  configOrOptions: ServerConfig | StorageServiceOptions = defaultConfig,
  storageClient?: Storage,
  loggerInstance?: AppLogger,
): StorageService {
  const rest: RestStorageDeps = [undefined, undefined, undefined, loggerInstance];
  return new GcsStorageService(configOrOptions, storageClient, ...rest);
}
