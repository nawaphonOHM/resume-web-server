/**
 * Google Cloud Storage implementation of {@link StorageService} adhering to SOLID principles.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import type { Storage, Bucket } from '@google-cloud/storage';
import { type ServerConfig, config as defaultConfig } from './config/config.ts';
import { HTTP_STATUS_NOT_FOUND } from './http/http_status_codes.ts';
import type { AppLogger } from './logger/logger_types.ts';
import {
  type ResolvedStorageDeps,
  type RestStorageDeps,
  resolveStorageDeps,
} from './storage/storage_deps_resolver.ts';
import { logStorageErrorClassification } from './storage/storage_error_telemetry.ts';
import {
  type StreamDispatchContext,
  createStreamParams,
  dispatchStream,
} from './storage/storage_stream_options.ts';
import type { StorageService, StorageServiceOptions } from './storage/storage_types.ts';

export class GcsStorageService implements StorageService {
  private readonly deps: ResolvedStorageDeps;
  private readonly bucket: Bucket;

  /**
   * Creates a new `GcsStorageService` instance with dependency injection support.
   *
   * @param configOrOptions - Server configuration providing `bucketName` and `prefix` or {@link StorageServiceOptions} options object. Defaults to {@link defaultConfig}.
   * @param storageClient - Optional custom `Storage` client instance for dependency injection and testing.
   * @param rest - Optional custom pathResolver, etagFormatter, errorClassifier, and logger instances.
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
   * Resolves a relative asset path into the full GCS object key.
   *
   * @param objectName - The relative asset path.
   * @returns The fully qualified object key.
   */
  public resolveObjectName(objectName: string): string {
    return this.deps.pathResolver.resolveObjectName(objectName);
  }

  private logExistsError(is404: boolean, fullPath: string): number {
    const input = { is404, fullPath, notFoundStatusCode: HTTP_STATUS_NOT_FOUND };
    return logStorageErrorClassification(this.deps.logger, input).statusCode;
  }

  private logExistsFailure(err: unknown, fullPath: string, statusCode: number): void {
    this.deps.logger.error('Storage error checking file existence', err, {
      path: fullPath,
      statusCode,
    });
  }

  private handleFileExistsError(err: unknown, fullPath: string): boolean {
    const is404 = this.deps.errorClassifier.isNotFoundError(err);
    const statusCode = this.logExistsError(is404, fullPath);
    if (is404) return false;
    this.logExistsFailure(err, fullPath, statusCode);
    throw err;
  }

  /**
   * Checks whether an object exists in Google Cloud Storage.
   *
   * @param objectName - The relative path of the object to check.
   * @returns A promise resolving to `true` if the file exists, or `false` if not found.
   */
  public async fileExists(objectName: string): Promise<boolean> {
    const fullPath = this.resolveObjectName(objectName);
    const file = this.bucket.file(fullPath);
    try {
      const [exists] = await file.exists();
      return exists;
    } catch (err: unknown) {
      return this.handleFileExistsError(err, fullPath);
    }
  }

  private createStreamContext(fullPath: string): StreamDispatchContext {
    return {
      bucket: this.bucket,
      fullPath,
      etagFormatter: this.deps.etagFormatter,
      errorClassifier: this.deps.errorClassifier,
      logger: this.deps.logger,
    };
  }

  /**
   * Streams a file from Google Cloud Storage to the HTTP response, or handles HEAD request metadata.
   *
   * @param name - The relative path of the object to stream.
   * @param res - The outgoing HTTP server response.
   * @param type - The MIME content-type string to set on the response.
   * @param rest - Tuple of [isHashedAsset, isHeadRequest?, notFoundStatusCode?].
   * @returns A promise that resolves when streaming completes or an HTTP error response is sent.
   */
  public async streamFile(
    name: string,
    res: ServerResponse,
    type: string,
    ...rest: [boolean, boolean?, number?]
  ): Promise<void> {
    const params = createStreamParams(name, res, type, rest);
    return dispatchStream(this.createStreamContext(this.resolveObjectName(name)), params);
  }
}

/**
 * Factory function creating a {@link StorageService} instance backed by Google Cloud Storage.
 *
 * @param configOrOptions - Optional {@link ServerConfig} or {@link StorageServiceOptions} configuration.
 * @param storageClient - Optional custom `@google-cloud/storage` `Storage` client.
 * @param loggerInstance - Optional custom {@link AppLogger}.
 * @returns A fully initialized {@link StorageService} instance.
 *
 * @example
 * ```ts
 * const storageService = createStorageService();
 * const customService = createStorageService({
 *   port: 8080,
 *   host: '0.0.0.0',
 *   bucketName: 'my-bucket',
 *   prefix: 'site',
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
