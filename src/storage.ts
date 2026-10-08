/**
 * Google Cloud Storage (GCS) Integration and Asset Streaming Service.
 *
 * Provides object storage abstractions, streaming file delivery to Node.js HTTP responses,
 * RFC 9110 compliant ETag and gzip handling, GCS error inspection and categorization,
 * and socket teardown management following SOLID principles.
 *
 * @remarks
 * In Google Cloud Storage, objects stored with `Content-Encoding: gzip` are automatically
 * decompressed on the fly during read streaming by default (`createReadStream`).
 * Because the delivered representation bytes differ from the stored compressed entity,
 * this module adjusts headers per RFC 9110:
 * - Omits `Content-Length` and `Content-Encoding` on decompressed responses.
 * - Formats ETags as weak validators (`W/"..."`) when auto-decompression occurs.
 * - Mirrors GET response headers for HEAD requests per RFC 9110 §9.3.2 recommendation (SHOULD).
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import { Storage, type Bucket, type File } from '@google-cloud/storage';
import { type ServerConfig, config as defaultConfig } from './config.ts';
import { CACHE_CONTROL_IMMUTABLE, CACHE_CONTROL_NO_CACHE } from './mime.ts';
import { logger, type AppLogger } from './logger.ts';

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
 * Configuration options for initializing a {@link GcsStorageService} (Interface Segregation Principle).
 */
export interface StorageServiceOptions {
  /**
   * Server configuration providing `bucketName` and `prefix`. Defaults to {@link defaultConfig}.
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

/**
 * RFC 9110 compliant ETag formatting implementation (Single Responsibility Principle).
 */
export class RFC9110EtagFormatter implements IEtagFormatter {
  /**
   * Formats and normalizes an ETag string according to RFC 9110 HTTP semantics.
   *
   * @param rawEtag - Raw ETag string provided by storage metadata.
   * @param isGzip - Whether the object payload is gzipped and auto-decompressed.
   * @returns A formatted ETag string (quoted, optionally weak-prefixed), or an empty string if blank.
   */
  public formatEtag(rawEtag: string, isGzip: boolean): string {
    const trimmed = rawEtag.trim();
    if (trimmed === '') {
      return '';
    }

    let tag = trimmed;
    let isWeak = false;

    if (tag.startsWith('W/')) {
      isWeak = true;
      tag = tag.slice(2).trim();
    }

    // Ensure entity-tag value is enclosed in double quotes per RFC 9110
    if (!tag.startsWith('"')) {
      tag = `"${tag}`;
    }
    if (!tag.endsWith('"')) {
      tag = `${tag}"`;
    }

    if (isGzip || isWeak) {
      return `W/${tag}`;
    }
    return tag;
  }
}

/**
 * GCS error classifier distinguishing 404 Object Not Found from missing buckets / network errors (Single Responsibility Principle).
 */
export class GcsErrorClassifier implements IStorageErrorClassifier {
  /**
   * Checks whether an error message indicates that a GCS bucket does not exist.
   *
   * @param message - The error message string to inspect.
   * @returns `true` if the message indicates a missing bucket error, `false` otherwise.
   */
  private isMissingBucketMessage(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes('specified bucket') ||
      lower.includes('nosuchbucket') ||
      lower.includes('no such bucket') ||
      (lower.includes('bucket') &&
        (lower.includes('not found') ||
          lower.includes('not exist') ||
          lower.includes('does not exist') ||
          lower.includes('unknown') ||
          lower.includes('invalid') ||
          lower.includes('missing')))
    );
  }

  /**
   * Determines whether an error thrown by the GCS client represents a 404 Object Not Found condition.
   *
   * @param err - The caught error value to evaluate.
   * @returns `true` if the error specifically represents an object not found condition; otherwise `false`.
   */
  public isNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') {
      return false;
    }
    const e = err as Record<string, unknown>;
    const msg = typeof e['message'] === 'string' ? e['message'] : '';
    const lowerMsg = msg.toLowerCase();

    // Positive signal: if GCS explicitly reports 'No such object', it is an object 404
    // regardless of bucket names (e.g. 'my-bucket') or asset paths (e.g. 'assets/bucket/file.js')
    if (lowerMsg.includes('no such object')) {
      return true;
    }

    // Check for explicit missing bucket indications across top-level message and nested error list
    if (this.isMissingBucketMessage(msg)) {
      return false;
    }

    const errors = Array.isArray(e['errors']) ? (e['errors'] as Record<string, unknown>[]) : [];
    for (const subErr of errors) {
      if (typeof subErr['message'] === 'string' && this.isMissingBucketMessage(subErr['message'])) {
        return false;
      }
    }

    // Check 404 status codes
    if (
      e['code'] === 404 ||
      e['code'] === '404' ||
      e['statusCode'] === 404 ||
      e['status'] === 404
    ) {
      return true;
    }

    // Check generic not found messages or reasons (having ruled out missing bucket above)
    if (lowerMsg.includes('not found')) {
      return true;
    }

    for (const subErr of errors) {
      if (
        subErr['reason'] === 'notFound' ||
        (typeof subErr['message'] === 'string' &&
          subErr['message'].toLowerCase().includes('not found'))
      ) {
        return true;
      }
    }

    return false;
  }
}

/**
 * Storage key path resolver applying bucket prefixes and normalizing leading slashes (Single Responsibility Principle).
 */
export class StoragePathResolver implements IStorageKeyResolver {
  /**
   * The configured prefix directory.
   */
  private readonly prefix: string;

  /**
   * Optional application logger for telemetry and decision recording.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `StoragePathResolver`.
   *
   * @param prefix - Key prefix to prepend to relative asset paths.
   * @param logger - Optional application logger.
   */
  public constructor(prefix: string, logger?: AppLogger) {
    this.prefix = prefix;
    this.logger = logger;
  }

  /**
   * Resolves a relative asset path to the full GCS object key by prepending the configured prefix.
   *
   * @param objectName - The relative asset path.
   * @returns The fully qualified object key.
   */
  public resolveObjectName(objectName: string): string {
    const cleanPath = objectName.replace(/^\/+/, '');
    let resolvedKey: string;
    let reason: string;

    if (this.prefix === '') {
      resolvedKey = cleanPath;
      reason = 'No bucket prefix configured, using raw object path';
    } else if (cleanPath.startsWith(this.prefix + '/') || cleanPath === this.prefix) {
      resolvedKey = cleanPath;
      reason = `Object path already contains configured prefix '${this.prefix}'`;
    } else {
      resolvedKey = `${this.prefix}/${cleanPath}`;
      reason = `Applied bucket prefix '${this.prefix}' to relative path`;
    }

    this.logger?.decision({
      action: 'StorageKey',
      choice: resolvedKey,
      reason,
      level: 'debug',
      rawPath: objectName,
      prefix: this.prefix,
    });

    return resolvedKey;
  }
}

/**
 * Default singleton helper instances.
 */
const defaultEtagFormatter: IEtagFormatter = new RFC9110EtagFormatter();
const defaultErrorClassifier: IStorageErrorClassifier = new GcsErrorClassifier();

/**
 * Formats and normalizes an ETag string according to RFC 9110 HTTP semantics.
 *
 * @remarks
 * RFC 9110 §8.8.3 requires entity-tag values to be enclosed in double quotes and
 * defines the `W/` prefix syntax for weak validators. When resources are stored
 * gzipped but auto-decompressed by GCS during streaming, the representation bytes
 * change, so per RFC 9110 §8.8.1 a strong validator can no longer be used and must
 * be downgraded to a weak entity-tag (`W/"..."`).
 *
 * @param rawEtag - Raw ETag string provided by storage metadata.
 * @param isGzip - Whether the object payload is gzipped and auto-decompressed.
 * @returns A formatted ETag string (quoted, optionally weak-prefixed), or an empty string if input is blank.
 *
 * @example
 * ```ts
 * formatEtag('12345', false);     // '"12345"'
 * formatEtag('"12345"', true);    // 'W/"12345"'
 * formatEtag('W/"12345"', false); // 'W/"12345"'
 * formatEtag('', false);          // ''
 * ```
 */
export function formatEtag(rawEtag: string, isGzip: boolean): string {
  return defaultEtagFormatter.formatEtag(rawEtag, isGzip);
}

/**
 * Determines whether an error thrown by the GCS client represents a 404 Object Not Found condition.
 *
 * @remarks
 * Evaluates the caught error against the following decision procedure:
 * 1. Returns `true` if the top-level error message explicitly contains `'no such object'`.
 * 2. Returns `false` if the top-level message or any nested `errors[]` entry indicates a missing/invalid bucket.
 * 3. Returns `true` if `code`, `statusCode`, or `status` is `404` (or string `'404'`).
 * 4. Returns `true` if the top-level error message contains `'not found'`.
 * 5. Returns `true` if any nested `errors[]` entry has `reason === 'notFound'` or a message containing `'not found'`.
 * 6. Returns `false` otherwise.
 *
 * @param err - The caught error value to evaluate.
 * @returns `true` if the error specifically represents an object not found condition; otherwise `false`.
 *
 * @example
 * ```ts
 * try {
 *   await file.exists();
 * } catch (err) {
 *   if (isNotFoundError(err)) {
 *     // Object 404 handled cleanly
 *   }
 * }
 * ```
 */
export function isNotFoundError(err: unknown): boolean {
  return defaultErrorClassifier.isNotFoundError(err);
}

/**
 * Type guard checking whether a given value is a {@link StorageServiceOptions} configuration object.
 *
 * @param obj - The value to evaluate.
 * @returns `true` if `obj` conforms to {@link StorageServiceOptions}; otherwise `false`.
 */
function isStorageServiceOptions(obj: unknown): obj is StorageServiceOptions {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  return (
    'storageClient' in obj ||
    'pathResolver' in obj ||
    'etagFormatter' in obj ||
    'errorClassifier' in obj ||
    'logger' in obj ||
    ('config' in obj && typeof (obj as StorageServiceOptions).config === 'object')
  );
}

/**
 * Google Cloud Storage implementation of {@link StorageService} adhering to SOLID principles.
 */
export class GcsStorageService implements StorageService {
  /**
   * The underlying `@google-cloud/storage` client instance.
   */
  private readonly storage: Storage;

  /**
   * The GCS bucket instance bound to the configured bucket name.
   */
  private readonly bucket: Bucket;

  /**
   * Path key resolver strategy.
   */
  private readonly pathResolver: IStorageKeyResolver;

  /**
   * ETag formatting strategy.
   */
  private readonly etagFormatter: IEtagFormatter;

  /**
   * Error classification strategy.
   */
  private readonly errorClassifier: IStorageErrorClassifier;

  /**
   * Injected application logger.
   */
  private readonly logger: AppLogger;

  /**
   * Creates a new `GcsStorageService` instance with dependency injection support.
   *
   * @param configOrOptions - Server configuration providing `bucketName` and `prefix` or {@link StorageServiceOptions} options object. Defaults to {@link defaultConfig}.
   * @param storageClient - Optional custom `Storage` client instance for dependency injection and testing.
   * @param pathResolver - Optional custom {@link IStorageKeyResolver}. Defaults to {@link StoragePathResolver}.
   * @param etagFormatter - Optional custom {@link IEtagFormatter}. Defaults to {@link RFC9110EtagFormatter}.
   * @param errorClassifier - Optional custom {@link IStorageErrorClassifier}. Defaults to {@link GcsErrorClassifier}.
   * @param loggerInstance - Optional custom {@link AppLogger}. Defaults to singleton {@link logger}.
   */
  public constructor(
    configOrOptions: ServerConfig | StorageServiceOptions = defaultConfig,
    storageClient?: Storage,
    pathResolver?: IStorageKeyResolver,
    etagFormatter?: IEtagFormatter,
    errorClassifier?: IStorageErrorClassifier,
    loggerInstance?: AppLogger,
  ) {
    let effectiveConfig: ServerConfig;
    let effectiveStorageClient = storageClient;
    let effectivePathResolver = pathResolver;
    let effectiveEtagFormatter = etagFormatter;
    let effectiveErrorClassifier = errorClassifier;
    let effectiveLogger = loggerInstance;

    if (isStorageServiceOptions(configOrOptions)) {
      effectiveConfig = configOrOptions.config ?? defaultConfig;
      effectiveStorageClient = configOrOptions.storageClient ?? effectiveStorageClient;
      effectivePathResolver = configOrOptions.pathResolver ?? effectivePathResolver;
      effectiveEtagFormatter = configOrOptions.etagFormatter ?? effectiveEtagFormatter;
      effectiveErrorClassifier = configOrOptions.errorClassifier ?? effectiveErrorClassifier;
      effectiveLogger = configOrOptions.logger ?? effectiveLogger;
    } else {
      effectiveConfig = configOrOptions;
    }

    this.logger = effectiveLogger ?? logger;
    this.storage = effectiveStorageClient ?? new Storage();
    this.bucket = this.storage.bucket(effectiveConfig.bucketName);
    this.pathResolver =
      effectivePathResolver ?? new StoragePathResolver(effectiveConfig.prefix, this.logger);
    this.etagFormatter = effectiveEtagFormatter ?? new RFC9110EtagFormatter();
    this.errorClassifier = effectiveErrorClassifier ?? new GcsErrorClassifier();
  }

  /**
   * Records decision telemetry for ETag selection and header suppression.
   */
  private logEtagDecision(options: {
    rawEtag?: string;
    formattedEtag: string;
    contentEncoding?: string;
    isGzip: boolean;
    fullPath: string;
  }): void {
    const { rawEtag, formattedEtag, contentEncoding, isGzip, fullPath } = options;
    if (isGzip) {
      this.logger.decision({
        action: 'StorageEtag',
        choice:
          formattedEtag !== ''
            ? `Weak ETag (${formattedEtag})`
            : 'Omit Content-Length and Content-Encoding',
        reason:
          'GCS object has gzip Content-Encoding and will be auto-decompressed on the fly (RFC 9110)',
        level: 'debug',
        rawEtag,
        formattedEtag: formattedEtag !== '' ? formattedEtag : undefined,
        contentEncoding,
        isGzip: true,
        path: fullPath,
        omittedHeaders: 'Content-Length, Content-Encoding',
      });
    } else if (formattedEtag !== '') {
      this.logger.decision({
        action: 'StorageEtag',
        choice: `Strong ETag (${formattedEtag})`,
        reason:
          'GCS object is uncompressed or identity encoded, preserving strong validator and Content-Length (RFC 9110)',
        level: 'debug',
        rawEtag,
        formattedEtag,
        isGzip: false,
        path: fullPath,
      });
    }
  }

  /**
   * Records decision telemetry for error classification and status code mapping.
   */
  private logErrorClassification(options: {
    is404: boolean;
    fullPath: string;
    notFoundStatusCode?: number;
    isHead?: boolean;
    headersSent?: boolean;
    currentStatusCode?: number;
  }): { choice: string; reason: string; level: 'debug' | 'warn'; statusCode: number } {
    const {
      is404,
      notFoundStatusCode = 404,
      fullPath,
      isHead,
      headersSent = false,
      currentStatusCode = 200,
    } = options;

    if (headersSent) {
      const choice = `abort connection (headers already sent, status ${String(currentStatusCode)})`;
      const reason = `Storage ${isHead ? 'metadata' : 'read stream'} error occurred after HTTP response headers were already sent with status ${String(currentStatusCode)}`;
      const level = 'warn' as const;

      this.logger.decision({
        action: 'ErrorClassifier',
        choice,
        reason,
        level,
        statusCode: currentStatusCode,
        path: fullPath,
        ...(isHead !== undefined ? { isHead } : {}),
        is404,
        headersSent: true,
      });

      return { choice, reason, level, statusCode: currentStatusCode };
    }

    const statusCode = is404 ? notFoundStatusCode : 502;
    const choice = statusCode === 404 ? '404 Not Found' : `${String(statusCode)} Bad Gateway`;
    let reason: string;
    if (is404) {
      if (notFoundStatusCode !== 404) {
        reason = `GCS error indicated object not found, mapped to ${String(notFoundStatusCode)} by caller (missing SPA index.html fallback)`;
      } else {
        reason = 'GCS error indicated object not found, not missing bucket';
      }
    } else {
      reason = 'GCS error indicates bucket missing or storage backend failure';
    }

    const level = is404 && notFoundStatusCode === 404 ? ('debug' as const) : ('warn' as const);

    this.logger.decision({
      action: 'ErrorClassifier',
      choice,
      reason,
      level,
      statusCode,
      path: fullPath,
      ...(isHead !== undefined ? { isHead } : {}),
      is404,
    });

    return { choice, reason, level, statusCode };
  }

  /**
   * Resolves a relative asset path to the full GCS object key by prepending the configured prefix.
   *
   * @param objectName - The relative asset path.
   * @returns The fully qualified object key in the GCS bucket.
   */
  public resolveObjectName(objectName: string): string {
    return this.pathResolver.resolveObjectName(objectName);
  }

  /**
   * Asynchronously checks whether an object exists in the storage bucket.
   *
   * @param objectName - The relative path of the asset to verify.
   * @returns A promise resolving to `true` if the object exists, or `false` if not found.
   * @throws Rethrows unexpected errors (e.g., authentication, missing bucket, network errors).
   */
  public async fileExists(objectName: string): Promise<boolean> {
    const fullPath = this.resolveObjectName(objectName);
    const file = this.bucket.file(fullPath);
    try {
      const [exists] = await file.exists();
      return exists;
    } catch (err: unknown) {
      const is404 = this.errorClassifier.isNotFoundError(err);
      const { statusCode } = this.logErrorClassification({
        is404,
        fullPath,
        notFoundStatusCode: 404,
      });
      if (is404) {
        return false;
      }
      this.logger.error('Storage error checking file existence', err, {
        path: fullPath,
        statusCode,
      });
      throw err;
    }
  }

  /**
   * Streams a file from GCS to the HTTP response stream, handling HEAD and GET requests.
   *
   * @remarks
   * Handles metadata and read-stream errors by sending an appropriate HTTP error response (`notFoundStatusCode` or 502) and resolving the promise; unexpected setup errors prior to handler dispatch (such as object-name resolution or file-handle creation) reject the returned promise.
   *
   * @param objectName - Target object key in storage.
   * @param res - Node.js HTTP server response stream.
   * @param contentType - MIME content-type to set on the response.
   * @param isHashedAsset - Whether the asset is content-hashed (controls `Cache-Control` header).
   * @param isHeadRequest - Optional flag indicating a HEAD request. Defaults to `false`.
   * @param notFoundStatusCode - HTTP status code to return if the object is missing. Defaults to `404`.
   * @returns A promise that resolves when streaming finishes or an HTTP error response is sent; rejects if unexpected setup errors occur.
   */
  public async streamFile(
    objectName: string,
    res: ServerResponse,
    contentType: string,
    isHashedAsset: boolean,
    isHeadRequest = false,
    notFoundStatusCode = 404,
  ): Promise<void> {
    const fullPath = this.resolveObjectName(objectName);
    const file = this.bucket.file(fullPath);
    const cacheControl = isHashedAsset ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_NO_CACHE;

    this.logger.decision({
      action: 'StorageStream',
      choice: isHeadRequest ? 'HEAD metadata inspection' : 'GET byte streaming',
      reason: isHeadRequest
        ? 'Request method is HEAD, inspecting GCS metadata without streaming response body'
        : 'Request method is GET, streaming file payload from GCS to HTTP response',
      level: 'debug',
      objectName,
      fullPath,
      contentType,
      isHashedAsset,
      isHeadRequest,
      notFoundStatusCode,
    });

    if (isHeadRequest) {
      return this.handleHeadRequest(
        file,
        res,
        contentType,
        cacheControl,
        notFoundStatusCode,
        fullPath,
      );
    }

    return this.handleGetRequest(
      file,
      res,
      contentType,
      cacheControl,
      notFoundStatusCode,
      fullPath,
    );
  }

  /**
   * Handles HTTP HEAD requests by fetching GCS object metadata without streaming payload bytes.
   *
   * @param file - The GCS file handle.
   * @param res - The Node.js HTTP server response.
   * @param contentType - The MIME content-type string.
   * @param cacheControl - The Cache-Control header value.
   * @param notFoundStatusCode - HTTP status code to emit if object does not exist. Defaults to `404`.
   * @param fullPath - The resolved GCS object path.
   * @returns A promise that resolves once headers are sent and response ended.
   */
  private async handleHeadRequest(
    file: File,
    res: ServerResponse,
    contentType: string,
    cacheControl: string,
    notFoundStatusCode = 404,
    fullPath = file.name,
  ): Promise<void> {
    try {
      const [metadata] = await file.getMetadata();
      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', cacheControl);

        const encoding = metadata.contentEncoding?.trim().toLowerCase();
        const isGzip = encoding === 'gzip';

        // GCS createReadStream auto-decompresses gzipped objects on the fly by default.
        // Since GET omits Content-Length and Content-Encoding for gzip auto-decompressed payloads,
        // HEAD must match GET per RFC 9110 §9.3.2.
        if (!isGzip) {
          if (metadata.size !== undefined) {
            res.setHeader('Content-Length', String(metadata.size));
          }
          if (metadata.contentEncoding && encoding !== 'identity') {
            res.setHeader('Content-Encoding', metadata.contentEncoding);
          }
        }

        let formattedEtag = '';
        if (metadata.etag) {
          formattedEtag = this.etagFormatter.formatEtag(metadata.etag, isGzip);
          if (formattedEtag !== '') {
            res.setHeader('ETag', formattedEtag);
          }
        }

        this.logEtagDecision({
          rawEtag: metadata.etag,
          formattedEtag,
          contentEncoding: metadata.contentEncoding,
          isGzip,
          fullPath,
        });

        res.end();
      }
    } catch (err: unknown) {
      const is404 = this.errorClassifier.isNotFoundError(err);

      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        res.removeHeader('Content-Length');
        res.removeHeader('ETag');
        res.removeHeader('Content-Encoding');
        res.removeHeader('Last-Modified');

        const { statusCode } = this.logErrorClassification({
          is404,
          fullPath,
          notFoundStatusCode,
          isHead: true,
          headersSent: false,
        });

        if (statusCode !== 404) {
          this.logger.error('Failed to retrieve metadata for asset from storage', err, {
            path: fullPath,
            statusCode,
            method: 'HEAD',
          });
        }

        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(statusCode === 404 ? 'Not Found' : 'Bad Gateway');
      } else {
        this.logErrorClassification({
          is404,
          fullPath,
          notFoundStatusCode,
          isHead: true,
          headersSent: res.headersSent,
          currentStatusCode: res.statusCode,
        });

        this.logger.error(
          'Failed to retrieve metadata for asset from storage (connection aborted mid-stream)',
          err,
          {
            path: fullPath,
            statusCode: res.statusCode,
            method: 'HEAD',
          },
        );

        if (!res.writableEnded && !res.destroyed) {
          res.destroy();
        }
      }
    }
  }

  /**
   * Handles HTTP GET requests by creating a GCS read stream and piping bytes to the response.
   *
   * @param file - The GCS file handle.
   * @param res - The Node.js HTTP server response.
   * @param contentType - The MIME content-type string.
   * @param cacheControl - The Cache-Control header value.
   * @param notFoundStatusCode - HTTP status code to emit if object does not exist. Defaults to `404`.
   * @param fullPath - The resolved GCS object path.
   * @returns A promise that resolves when the response finishes or errors.
   */
  private handleGetRequest(
    file: File,
    res: ServerResponse,
    contentType: string,
    cacheControl: string,
    notFoundStatusCode = 404,
    fullPath = file.name,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const readStream = file.createReadStream();

      const finishOnce = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve();
        }
      };

      const onClientClose = () => {
        if (!res.writableEnded) {
          readStream.destroy();
        }
        finishOnce();
      };

      const onError = (err: unknown) => {
        const is404 = this.errorClassifier.isNotFoundError(err);

        if (res.headersSent) {
          this.logErrorClassification({
            is404,
            fullPath,
            notFoundStatusCode,
            isHead: false,
            headersSent: true,
            currentStatusCode: res.statusCode,
          });

          this.logger.error(
            'Failed to stream asset from storage (connection aborted mid-stream)',
            err,
            {
              path: fullPath,
              statusCode: res.statusCode,
              method: 'GET',
            },
          );

          if (!res.writableEnded && !res.destroyed) {
            res.destroy();
          }
        } else {
          const { statusCode } = this.logErrorClassification({
            is404,
            fullPath,
            notFoundStatusCode,
            isHead: false,
            headersSent: false,
          });

          if (statusCode !== 404) {
            this.logger.error('Failed to stream asset from storage', err, {
              path: fullPath,
              statusCode,
              method: 'GET',
            });
          }

          if (!res.destroyed && !res.writableEnded) {
            res.removeHeader('Content-Length');
            res.removeHeader('ETag');
            res.removeHeader('Content-Encoding');
            res.removeHeader('Last-Modified');

            res.statusCode = statusCode;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(statusCode === 404 ? 'Not Found' : 'Bad Gateway');
          }
        }
        finishOnce();
      };

      const onResponse = (response: { statusCode?: number; headers?: Record<string, string> }) => {
        if (response.statusCode && response.statusCode >= 400) {
          readStream.unpipe(res);
        } else if (!res.headersSent && !res.destroyed) {
          res.statusCode = 200;
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', cacheControl);

          const encoding = response.headers?.['content-encoding']?.trim().toLowerCase();
          const isGzip = encoding === 'gzip';

          // GCS createReadStream auto-decompresses gzipped objects on the fly by default.
          // For gzip: omit Content-Length and Content-Encoding, convert ETag to weak validator.
          // For non-gzip (uncompressed or non-decompressed like br/deflate): forward headers.
          if (!isGzip) {
            if (response.headers?.['content-length']) {
              res.setHeader('Content-Length', response.headers['content-length']);
            }
            if (response.headers?.['content-encoding'] && encoding !== 'identity') {
              res.setHeader('Content-Encoding', response.headers['content-encoding']);
            }
          }

          let formattedEtag = '';
          if (response.headers?.['etag']) {
            formattedEtag = this.etagFormatter.formatEtag(response.headers['etag'], isGzip);
            if (formattedEtag !== '') {
              res.setHeader('ETag', formattedEtag);
            }
          }

          this.logEtagDecision({
            rawEtag: response.headers?.['etag'],
            formattedEtag,
            contentEncoding: response.headers?.['content-encoding'],
            isGzip,
            fullPath,
          });
        }
      };

      const cleanup = () => {
        res.off('close', onClientClose);
        res.off('finish', finishOnce);
        readStream.off('error', onError);
        readStream.off('response', onResponse);
        // Prevent unhandled error events on the stream during subsequent teardown
        readStream.on('error', () => {
          /* noop */
        });
      };

      res.on('close', onClientClose);
      res.on('finish', finishOnce);
      readStream.on('error', onError);
      readStream.on('response', onResponse);

      // Pre-set default 200 headers on response so if data chunks flow immediately,
      // headers are sent with the specified contentType and cacheControl.
      if (!res.headersSent) {
        res.statusCode = 200;
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', cacheControl);
      }

      readStream.pipe(res);
    });
  }
}

/**
 * Factory function for creating a {@link StorageService} instance.
 *
 * @param configOrOptions - Server configuration options or {@link StorageServiceOptions}. Defaults to {@link defaultConfig}.
 * @param storageClient - Optional custom `Storage` client instance.
 * @param loggerInstance - Optional custom {@link AppLogger}. Defaults to singleton {@link logger}.
 * @returns A configured {@link StorageService} instance.
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
  return new GcsStorageService(
    configOrOptions,
    storageClient,
    undefined,
    undefined,
    undefined,
    loggerInstance,
  );
}
