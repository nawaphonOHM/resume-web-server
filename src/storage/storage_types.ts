/**
 * Type definitions and contracts for Google Cloud Storage service and asset streaming.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import type { Storage } from '@google-cloud/storage';
import type { ServerConfig } from '../config/config_types.ts';
import type { AppLogger } from '../logger/logger_types.ts';

/**
 * Contract for resolving relative asset paths into storage keys (Interface Segregation Principle).
 */
export interface IStorageKeyResolver {
  /**
   * Resolves a relative asset path into a fully qualified storage object key.
   *
   * @param objectName - The relative asset path.
   * @returns The resolved object key with storage prefix applied.
   */
  resolveObjectName(objectName: string): string;
}

/**
 * Contract for checking the existence of objects in storage (Interface Segregation Principle).
 */
export interface IStorageExistenceChecker {
  /**
   * Checks whether an object exists in storage.
   *
   * @param objectName - The relative path / key of the object to check.
   * @returns A promise resolving to `true` if the file exists, or `false` if not found.
   */
  fileExists(objectName: string): Promise<boolean>;
}

/**
 * Contract for streaming files from storage to HTTP responses (Interface Segregation Principle).
 */
export interface IStorageStreamer {
  /**
   * Streams a file from storage to an HTTP response or sends metadata headers for HEAD requests.
   *
   * @param objectName - The relative path / key of the object to retrieve.
   * @param res - The Node.js server response stream to write to.
   * @param contentType - The MIME content-type to set on the response.
   * @param isHashedAsset - Whether the asset is content-hashed (selects immutable vs. revalidating cache policy).
   * @param isHeadRequest - Optional flag indicating whether this is a HEAD request (metadata only). Defaults to `false`.
   * @param notFoundStatusCode - HTTP status code to return if the object is not found. Defaults to `404`.
   * @returns A promise that resolves when streaming finishes or an HTTP error response is sent.
   */
  streamFile(
    objectName: string,
    res: ServerResponse,
    contentType: string,
    isHashedAsset: boolean,
    isHeadRequest?: boolean,
    notFoundStatusCode?: number,
  ): Promise<void>;
}

/**
 * Contract for formatting HTTP ETags according to RFC 9110 (Single Responsibility Principle).
 */
export interface IEtagFormatter {
  /**
   * Formats and normalizes an ETag string according to RFC 9110 HTTP semantics.
   *
   * @param rawEtag - Raw ETag string provided by storage metadata.
   * @param isGzip - Whether the object payload is gzipped and auto-decompressed.
   * @returns A formatted ETag string (quoted, optionally weak-prefixed), or an empty string if blank.
   */
  formatEtag(rawEtag: string, isGzip: boolean): string;
}

/**
 * Contract for classifying storage backend errors (Single Responsibility Principle).
 */
export interface IStorageErrorClassifier {
  /**
   * Determines whether an error thrown by the storage client represents a 404 Object Not Found condition.
   *
   * @param err - The caught error value to evaluate.
   * @returns `true` if the error specifically represents an object not found condition; otherwise `false`.
   */
  isNotFoundError(err: unknown): boolean;
}

/**
 * Service contract for interacting with object storage and streaming static assets (Interface Segregation Principle).
 */
export interface StorageService
  extends IStorageKeyResolver, IStorageExistenceChecker, IStorageStreamer {}

/**
 * Configuration options for initializing a storage service (Interface Segregation Principle).
 */
export interface StorageServiceOptions {
  /**
   * Server configuration providing `bucketName` and `prefix`.
   */
  readonly config?: ServerConfig;

  /**
   * Custom `@google-cloud/storage` `Storage` client instance.
   */
  readonly storageClient?: Storage;

  /**
   * Custom storage key path resolver strategy.
   */
  readonly pathResolver?: IStorageKeyResolver;

  /**
   * Custom ETag formatting strategy.
   */
  readonly etagFormatter?: IEtagFormatter;

  /**
   * Custom error classification strategy.
   */
  readonly errorClassifier?: IStorageErrorClassifier;

  /**
   * Application logger for recording operational decisions and error traces.
   */
  readonly logger?: AppLogger;
}
