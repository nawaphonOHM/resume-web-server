/**
 * HTTP Request Router and Security Dispatcher.
 *
 * Provides request routing, standard security headers, health check endpoint handling,
 * defense-in-depth URL path sanitization and directory traversal protection,
 * and Single Page Application (SPA) fallback resolution following SOLID principles.
 *
 * @remarks
 * The router enforces strict HTTP method constraints (only `GET` and `HEAD` permitted),
 * injects baseline security headers on every response, sanitizes incoming URLs against
 * directory traversal attacks (null bytes, encoded separators, double encoding, dot-dot sequences),
 * and routes requests to either static assets or the SPA HTML entry point (`index.html`).
 *
 * @packageDocumentation
 */

import { posix } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DefaultMimeTypeResolver,
  DefaultAssetClassifier,
  DefaultCachePolicyResolver,
  type IMimeTypeResolver,
  type IAssetClassifier,
  type ICachePolicyResolver,
} from './mime.ts';
import { createStorageService, type StorageService } from './storage.ts';
import { logger, type AppLogger } from './logger.ts';

/**
 * Strips query parameters and hash fragments from a raw URL to prevent sensitive query tokens or parameters from being logged.
 *
 * @param rawUrl - The raw URL string or undefined.
 * @returns Sanitized path portion of the URL without query string or hash fragment.
 */
export function sanitizeUrlForLogging(rawUrl: string | undefined): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return '';
  }
  return rawUrl.split(/[?#]/)[0] ?? '';
}

/**
 * Baseline HTTP security headers injected into every server response.
 *
 * @remarks
 * - `X-Content-Type-Options: nosniff`: Prevents browsers from MIME-sniffing the response body away from the declared Content-Type.
 * - `X-Frame-Options: SAMEORIGIN`: Prevents framing across origins to mitigate clickjacking attacks.
 * - `Referrer-Policy: strict-origin-when-cross-origin`: Sends origin, path, and query on same-origin requests, but only origin on HTTPS cross-origin requests.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

/**
 * Health check status payload returned by the `/health` endpoint.
 */
export interface HealthPayload {
  /**
   * Health status indicator (e.g. `'UP'`).
   */
  readonly status: string;

  /**
   * ISO 8601 UTC timestamp of the health check request.
   */
  readonly timestamp: string;

  /**
   * Process uptime in seconds.
   */
  readonly uptime: number;
}

/**
 * Result of URL path validation and sanitization.
 */
export interface PathValidationResult {
  /**
   * Whether the path passed all security and traversal validation checks.
   */
  readonly valid: boolean;

  /**
   * The sanitized, normalized POSIX path (if valid), or an empty string (if invalid).
   */
  readonly path: string;

  /**
   * Error message describing why the path was rejected when `valid` is `false`.
   */
  readonly error?: string;
}

/**
 * Contract for sanitizing and validating request URL paths against traversal attacks (Single Responsibility Principle).
 */
export interface IPathSanitizer {
  /**
   * Validates and sanitizes a raw request URL.
   *
   * @param rawUrl - The raw URL string from `req.url` (or `undefined`).
   * @returns A {@link PathValidationResult} indicating validity, normalized path, and optional error.
   */
  validateAndSanitize(rawUrl: string | undefined): PathValidationResult;
}

/**
 * Contract for injecting security headers into HTTP responses (Single Responsibility Principle).
 */
export interface ISecurityHeadersPolicy {
  /**
   * Applies configured security headers to the given server response.
   *
   * @param res - The outgoing HTTP server response.
   */
  applyHeaders(res: ServerResponse): void;

  /**
   * Returns a copy of the active security headers dictionary.
   */
  getHeaders(): Readonly<Record<string, string>>;
}

/**
 * Contract for validating incoming HTTP request methods (Single Responsibility Principle).
 */
export interface IHttpMethodValidator {
  /**
   * Checks whether the HTTP method is permitted and sends a 405 Method Not Allowed response if invalid.
   *
   * @param req - The incoming HTTP request.
   * @param res - The outgoing HTTP response.
   * @returns `true` if the method is permitted (`GET` or `HEAD`), `false` if rejected and response sent.
   */
  validate(req: IncomingMessage, res: ServerResponse): boolean;
}

/**
 * Contract for providing health status telemetry (Single Responsibility Principle).
 */
export interface IHealthStatusProvider {
  /**
   * Generates a health status payload.
   *
   * @returns Current {@link HealthPayload}.
   */
  getHealthStatus(): HealthPayload;
}

/**
 * Contract for handling health check endpoint requests (Single Responsibility Principle).
 */
export interface IHealthCheckHandler {
  /**
   * Handles `/health` requests if the clean path matches.
   *
   * @param cleanPath - The normalized, leading/trailing slash stripped path.
   * @param res - Outgoing server response.
   * @param isHead - Whether the request method is HEAD.
   * @returns `true` if the request was handled as a health check, `false` otherwise.
   */
  handle(cleanPath: string, res: ServerResponse, isHead: boolean): boolean;
}

/**
 * Contract for dispatching HTTP requests to storage or endpoints (Interface Segregation Principle).
 */
export interface IHttpRequestDispatcher {
  /**
   * Dispatches an incoming HTTP request through the security and routing pipeline.
   *
   * @param req - The Node.js incoming HTTP request.
   * @param res - The Node.js outgoing server response.
   * @returns A promise that resolves when the request has been fully handled and response ended.
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/**
 * Configurable dependencies and strategies for {@link Router} (Dependency Inversion Principle).
 */
export interface RouterDependencies {
  /**
   * The storage service backend used to retrieve static files and SPA entrypoints.
   */
  readonly storageService?: StorageService;

  /**
   * URL path validator and sanitizer strategy.
   */
  readonly pathSanitizer?: IPathSanitizer;

  /**
   * Security headers injection strategy.
   */
  readonly securityHeadersPolicy?: ISecurityHeadersPolicy;

  /**
   * HTTP method validator strategy.
   */
  readonly httpMethodValidator?: IHttpMethodValidator;

  /**
   * Health check endpoint handler strategy.
   */
  readonly healthCheckHandler?: IHealthCheckHandler;

  /**
   * MIME content-type resolver strategy.
   */
  readonly mimeResolver?: IMimeTypeResolver;

  /**
   * Asset classifier strategy.
   */
  readonly assetClassifier?: IAssetClassifier;

  /**
   * Optional injected application logger instance.
   */
  readonly logger?: AppLogger;
}

/**
 * Defense-in-depth path sanitizer guarding against directory traversal and malicious encoding.
 */
export class DefenseInDepthPathSanitizer implements IPathSanitizer {
  /**
   * Optional injected application logger for recording path sanitization decisions.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `DefenseInDepthPathSanitizer`.
   *
   * @param logger - Optional injected application logger.
   */
  public constructor(logger?: AppLogger) {
    this.logger = logger;
  }

  /**
   * Helper to log rejection decision and return an invalid validation result.
   */
  private reject(error: string, safeUrl: string): PathValidationResult {
    if (this.logger) {
      this.logger.decision({
        action: 'PathSanitizer',
        choice: 'reject request (400)',
        reason: error,
        level: 'debug',
        path: safeUrl,
        statusCode: 400,
      });
    }
    return { valid: false, path: '', error };
  }

  /**
   * Validates and sanitizes a raw request URL against directory traversal and injection attacks.
   *
   * @param rawUrl - The raw URL string from `req.url` (or `undefined`).
   * @returns A {@link PathValidationResult} indicating validity, the normalized path, and optional error reason.
   */
  public validateAndSanitize(rawUrl: string | undefined): PathValidationResult {
    const safeUrl = sanitizeUrlForLogging(rawUrl);

    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      return this.reject('Missing or empty request URL', safeUrl);
    }

    // 1. Separate path from query string and fragment before inspecting
    let rawPathWithScheme = rawUrl.split(/[?#]/)[0] ?? '';

    // 2. Strip optional scheme and host if absolute URL was provided (e.g. forward proxy requests)
    if (/^https?:\/\/[^/]+/i.test(rawPathWithScheme)) {
      rawPathWithScheme = rawPathWithScheme.replace(/^https?:\/\/[^/]+/i, '');
      if (rawPathWithScheme === '') {
        rawPathWithScheme = '/';
      }
    }

    // 3. Reject null byte injection (raw or percent-encoded)
    if (rawPathWithScheme.includes('\0') || /%00/i.test(rawPathWithScheme)) {
      return this.reject('Null byte injection detected', safeUrl);
    }

    // 4. Reject raw backslash path separators
    if (rawPathWithScheme.includes('\\')) {
      return this.reject('Backslash path separators not allowed', safeUrl);
    }

    // 5. Reject encoded path separators (%2f, %2F, %5c, %5C)
    if (/%(?:2f|5c)/i.test(rawPathWithScheme)) {
      return this.reject('Encoded path separators not allowed', safeUrl);
    }

    // 6. Reject double-encoded characters (%252e, %252f, %255c, %2500, etc.)
    if (/%25(?:2e|2f|5c|00)/i.test(rawPathWithScheme)) {
      return this.reject('Double-encoded characters detected', safeUrl);
    }

    // 7. Reject dot-dot / directory traversal sequences BEFORE normalization
    if (
      rawPathWithScheme.includes('..') ||
      /%2e%2e/i.test(rawPathWithScheme) ||
      /%2e\./i.test(rawPathWithScheme) ||
      /\.%2e/i.test(rawPathWithScheme)
    ) {
      return this.reject('Directory traversal sequence detected', safeUrl);
    }

    // 8. Percent-decode the path
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPathWithScheme);
    } catch {
      return this.reject('Malformed percent-encoded URL', safeUrl);
    }

    // 9. Inspect decoded path for illegal characters or traversal tokens
    if (decodedPath.includes('\0') || decodedPath.includes('\\') || decodedPath.includes('..')) {
      return this.reject('Invalid characters in decoded path', safeUrl);
    }

    // 10. Normalize the path using posix.normalize
    const pathToNormalize = decodedPath.startsWith('/') ? decodedPath : `/${decodedPath}`;
    const normalized = posix.normalize(pathToNormalize);

    // 11. Ensure normalized path does not escape the root
    if (
      normalized.startsWith('/../') ||
      normalized === '/..' ||
      normalized === '..' ||
      normalized.startsWith('../')
    ) {
      return this.reject('Path escapes root directory', safeUrl);
    }

    if (this.logger) {
      this.logger.decision({
        action: 'PathSanitizer',
        choice: `normalize path to '${normalized}'`,
        reason: 'Path passed all security and traversal validation checks',
        level: 'debug',
        path: normalized,
      });
    }

    return { valid: true, path: normalized };
  }
}

/**
 * Standard implementation of {@link ISecurityHeadersPolicy}.
 */
export class StandardSecurityHeadersPolicy implements ISecurityHeadersPolicy {
  /**
   * Internal headers map.
   */
  private readonly headers: Readonly<Record<string, string>>;

  /**
   * Creates a new `StandardSecurityHeadersPolicy`.
   *
   * @param headers - Optional custom headers map. Defaults to {@link SECURITY_HEADERS}.
   */
  public constructor(headers: Readonly<Record<string, string>> = SECURITY_HEADERS) {
    this.headers = headers;
  }

  /**
   * Applies security headers to the outgoing response.
   *
   * @param res - Outgoing server response.
   */
  public applyHeaders(res: ServerResponse): void {
    for (const [header, value] of Object.entries(this.headers)) {
      res.setHeader(header, value);
    }
  }

  /**
   * Retrieves the configured security headers dictionary.
   */
  public getHeaders(): Readonly<Record<string, string>> {
    return this.headers;
  }
}

/**
 * Standard implementation of {@link IHttpMethodValidator} restricting to `GET` and `HEAD`.
 */
export class StandardHttpMethodValidator implements IHttpMethodValidator {
  /**
   * Optional injected application logger for recording method validation decisions.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `StandardHttpMethodValidator`.
   *
   * @param logger - Optional injected application logger.
   */
  public constructor(logger?: AppLogger) {
    this.logger = logger;
  }

  /**
   * Validates that the request method is `GET` or `HEAD`; sends 405 otherwise.
   *
   * @param req - Incoming HTTP request.
   * @param res - Outgoing HTTP response.
   * @returns `true` if permitted; `false` if rejected.
   */
  public validate(req: IncomingMessage, res: ServerResponse): boolean {
    const method = req.method?.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      if (this.logger) {
        this.logger.decision({
          action: 'HttpMethodValidator',
          choice: 'reject request (405)',
          reason: `Method '${req.method ?? 'UNKNOWN'}' is not allowed (only GET and HEAD permitted)`,
          level: 'debug',
          method: req.method,
          allowedMethods: 'GET, HEAD',
          statusCode: 405,
          path: sanitizeUrlForLogging(req.url),
        });
      }
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end('Method Not Allowed');
      return false;
    }

    if (this.logger) {
      this.logger.decision({
        action: 'HttpMethodValidator',
        choice: 'permit request',
        reason: `HTTP method '${method}' is allowed (GET/HEAD permitted)`,
        level: 'debug',
        method,
      });
    }

    return true;
  }
}

/**
 * System uptime and timestamp health status provider.
 */
export class SystemHealthStatusProvider implements IHealthStatusProvider {
  /**
   * Generates the system health payload.
   */
  public getHealthStatus(): HealthPayload {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}

/**
 * Default health check endpoint handler for `/health`.
 */
export class DefaultHealthCheckHandler implements IHealthCheckHandler {
  /**
   * Health provider instance.
   */
  private readonly provider: IHealthStatusProvider;

  /**
   * Optional injected application logger.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `DefaultHealthCheckHandler`.
   *
   * @param provider - Injected health status provider. Defaults to {@link SystemHealthStatusProvider}.
   * @param logger - Optional injected application logger.
   */
  public constructor(
    provider: IHealthStatusProvider = new SystemHealthStatusProvider(),
    logger?: AppLogger,
  ) {
    this.provider = provider;
    this.logger = logger;
  }

  /**
   * Handles `/health` requests.
   *
   * @param cleanPath - Normalized route path.
   * @param res - Outgoing server response.
   * @param isHead - Flag indicating HEAD method.
   * @returns `true` if handled; `false` otherwise.
   */
  public handle(cleanPath: string, res: ServerResponse, isHead: boolean): boolean {
    if (cleanPath === 'health') {
      const payloadObj = this.provider.getHealthStatus();
      const payloadJson = JSON.stringify(payloadObj);

      if (this.logger) {
        this.logger.decision({
          action: 'HealthCheckHandler',
          choice: 'handle /health endpoint',
          reason: 'Exact match on health check endpoint path',
          level: 'debug',
          path: cleanPath,
          status: payloadObj.status,
          isHead,
        });
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Content-Length', String(Buffer.byteLength(payloadJson)));

      if (isHead) {
        res.end();
      } else {
        res.end(payloadJson);
      }
      return true;
    }
    return false;
  }
}

/**
 * Default singleton path sanitizer instance.
 */
const defaultPathSanitizer: IPathSanitizer = new DefenseInDepthPathSanitizer();

/**
 * Validates and sanitizes a raw request URL against directory traversal and injection attacks.
 *
 * @remarks
 * Applies multi-step defense-in-depth inspection:
 * 0. Discards undefined, non-string, or whitespace-only URLs (immediate rejection).
 * 1. Discards query parameters (`?`) and hash fragments (`#`).
 * 2. Strips optional absolute URL scheme and host (e.g. forward proxy requests).
 * 3. Rejects null byte injection (`\0` or `%00`).
 * 4. Rejects raw backslash path separators (`\`).
 * 5. Rejects encoded path separators (`%2f`, `%2F`, `%5c`, `%5C`).
 * 6. Rejects double-encoded characters (`%252e`, `%252f`, `%255c`, `%2500`, etc.).
 * 7. Rejects dot-dot directory traversal sequences before decoding (`..`, `%2e%2e`, `.%2e`, `%2e.`).
 * 8. Decodes URI percent-encoding via `decodeURIComponent`.
 * 9. Inspects decoded path for illegal characters or traversal tokens (`\0`, `\`, `..`).
 * 10. Normalizes path with `posix.normalize`.
 * 11. Verifies normalized path does not escape the root directory (`/../`, etc.).
 *
 * @param rawUrl - The raw URL string from `req.url` (or `undefined`).
 * @returns A {@link PathValidationResult} indicating validity, the normalized path, and optional error reason.
 *
 * @example
 * ```ts
 * validateAndSanitizePath('/assets/main.js'); // { valid: true, path: '/assets/main.js' }
 * validateAndSanitizePath('/../etc/passwd');   // { valid: false, path: '', error: 'Directory traversal sequence detected' }
 * validateAndSanitizePath('/app%00.js');       // { valid: false, path: '', error: 'Null byte injection detected' }
 * ```
 */
export function validateAndSanitizePath(rawUrl: string | undefined): PathValidationResult {
  return defaultPathSanitizer.validateAndSanitize(rawUrl);
}

/**
 * Type guard checking if a candidate object implements {@link StorageService}.
 *
 * @param candidate - Value to check.
 * @returns `true` if candidate implements storage streaming methods; `false` otherwise.
 */
function isStorageService(candidate: unknown): candidate is StorageService {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'streamFile' in candidate &&
    typeof (candidate as { streamFile?: unknown }).streamFile === 'function'
  );
}

/**
 * HTTP request router that applies security policies, routes health checks,
 * and delegates static asset and SPA requests to storage.
 */
export class Router implements IHttpRequestDispatcher {
  /**
   * The storage service backend used to retrieve static files and SPA entrypoints.
   */
  private readonly storageService: StorageService;

  /**
   * Path validation and sanitization strategy.
   */
  private readonly pathSanitizer: IPathSanitizer;

  /**
   * Security headers application policy.
   */
  private readonly securityHeadersPolicy: ISecurityHeadersPolicy;

  /**
   * HTTP method validator strategy.
   */
  private readonly httpMethodValidator: IHttpMethodValidator;

  /**
   * Health check endpoint handler.
   */
  private readonly healthCheckHandler: IHealthCheckHandler;

  /**
   * MIME content-type resolver strategy.
   */
  private readonly mimeResolver: IMimeTypeResolver;

  /**
   * Asset classifier strategy.
   */
  private readonly assetClassifier: IAssetClassifier;

  /**
   * Cache policy resolver used solely to report (log) the `Cache-Control` directive applied by the
   * storage layer. It is intentionally not injectable: `StorageService.streamFile` selects the
   * actual header from the `isHashed` flag using the same default policy and constants, so an
   * injected resolver would make the telemetry diverge from the header actually sent.
   */
  private readonly cachePolicyResolver: ICachePolicyResolver;

  /**
   * Injected or default application logger.
   */
  private readonly logger: AppLogger;

  /**
   * Creates a new `Router` instance with dependency injection support.
   *
   * @param storageServiceOrDependencies - Injected {@link StorageService} or {@link RouterDependencies} options object.
   * @param dependencies - Optional additional {@link RouterDependencies} when first argument is {@link StorageService}.
   */
  public constructor(
    storageServiceOrDependencies?: StorageService | RouterDependencies,
    dependencies?: RouterDependencies,
  ) {
    let resolvedStorage: StorageService | undefined;
    let resolvedDeps: RouterDependencies | undefined;

    if (isStorageService(storageServiceOrDependencies)) {
      resolvedStorage = storageServiceOrDependencies;
      resolvedDeps = dependencies;
    } else if (storageServiceOrDependencies !== undefined) {
      resolvedDeps = storageServiceOrDependencies;
      resolvedStorage = resolvedDeps.storageService;
    }

    this.logger = resolvedDeps?.logger ?? logger;
    this.storageService =
      resolvedStorage ??
      resolvedDeps?.storageService ??
      createStorageService(undefined, undefined, this.logger);
    this.pathSanitizer =
      resolvedDeps?.pathSanitizer ?? new DefenseInDepthPathSanitizer(this.logger);
    this.securityHeadersPolicy =
      resolvedDeps?.securityHeadersPolicy ?? new StandardSecurityHeadersPolicy();
    this.httpMethodValidator =
      resolvedDeps?.httpMethodValidator ?? new StandardHttpMethodValidator(this.logger);
    this.healthCheckHandler =
      resolvedDeps?.healthCheckHandler ?? new DefaultHealthCheckHandler(undefined, this.logger);
    this.mimeResolver =
      resolvedDeps?.mimeResolver ?? new DefaultMimeTypeResolver(undefined, undefined, this.logger);
    this.assetClassifier = resolvedDeps?.assetClassifier ?? new DefaultAssetClassifier(this.logger);
    this.cachePolicyResolver = new DefaultCachePolicyResolver(this.assetClassifier, this.logger);
  }

  /**
   * Dispatches an incoming HTTP request through the security and routing pipeline.
   *
   * @remarks
   * Pipeline steps:
   * 1. Injects baseline {@link SECURITY_HEADERS}.
   * 2. Enforces permitted HTTP methods (`GET` and `HEAD`); responds with `405 Method Not Allowed` for other methods.
   * 3. Validates and sanitizes path with {@link validateAndSanitizePath}; responds with `400 Bad Request` on failure.
   * 4. Serves `/health` endpoint returning JSON {@link HealthPayload} (or empty body for HEAD).
   * 5. For static assets (matched via `isStaticAsset`), streams file with resolved MIME type and caching headers.
   * 6. For SPA navigation routes, streams `index.html` with status `502 Bad Gateway` fallback if missing in storage.
   * 7. Catches unhandled errors thrown during streaming and responds with `500 Internal Server Error` if headers have not yet been sent.
   *
   * @param req - The Node.js incoming HTTP request.
   * @param res - The Node.js outgoing server response.
   * @returns A promise that resolves when the request has been fully handled and response ended.
   */
  public async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Apply security headers to all responses
    this.securityHeadersPolicy.applyHeaders(res);

    // 2. HTTP Method validation: only GET and HEAD are permitted
    if (!this.httpMethodValidator.validate(req, res)) {
      this.logger.decision({
        action: 'Router',
        choice: 'reject request (405)',
        reason: `HTTP method '${req.method ?? 'UNKNOWN'}' is not allowed (only GET and HEAD permitted)`,
        level: 'warn',
        method: req.method,
        allowedMethods: 'GET, HEAD',
        statusCode: 405,
        path: sanitizeUrlForLogging(req.url),
      });
      return;
    }

    const isHead = req.method?.toUpperCase() === 'HEAD';

    // 3. Path validation and sanitization
    const validation = this.pathSanitizer.validateAndSanitize(req.url);
    if (!validation.valid) {
      this.logger.decision({
        action: 'Router',
        choice: 'reject request (400)',
        reason: validation.error ?? 'Invalid or malicious URL path detected',
        level: 'warn',
        path: sanitizeUrlForLogging(req.url),
        statusCode: 400,
      });
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end('Bad Request');
      return;
    }

    const cleanPath = validation.path.replace(/^\/+|\/+$/g, '');

    // 4. Health check endpoint (GET /health and HEAD /health)
    if (this.healthCheckHandler.handle(cleanPath, res, isHead)) {
      return;
    }

    // 5. Static asset vs SPA history API fallback
    try {
      if (this.assetClassifier.isStaticAsset(cleanPath)) {
        const contentType = this.mimeResolver.getMimeType(cleanPath);
        const isHashed = this.assetClassifier.isHashedAsset(cleanPath);
        const cacheControl = this.cachePolicyResolver.getCacheControlHeader(cleanPath, isHashed);
        this.logger.decision({
          action: 'Router',
          choice: `stream static asset '${cleanPath}'`,
          reason: `Path has static asset extension with MIME type '${contentType}' and Cache-Control '${cacheControl}'`,
          level: 'info',
          path: cleanPath,
          contentType,
          isHashed,
          cacheControl,
          isHead,
        });
        await this.storageService.streamFile(cleanPath, res, contentType, isHashed, isHead);
        return;
      }

      // SPA navigation route: stream index.html
      this.logger.decision({
        action: 'Router',
        choice: 'SPA fallback (index.html)',
        reason: `Path '${cleanPath}' has no static asset extension, routing to SPA entrypoint`,
        level: 'info',
        path: cleanPath,
        fallbackTarget: 'index.html',
        isHead,
      });
      await this.storageService.streamFile(
        'index.html',
        res,
        'text/html; charset=utf-8',
        false,
        isHead,
        502,
      );
    } catch (err) {
      const safeUrl = sanitizeUrlForLogging(req.url);
      this.logger.error('Unhandled router error while processing request', err, {
        path: safeUrl,
        method: req.method,
        statusCode: 500,
      });
      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end('Internal Server Error');
      }
    }
  }
}

/**
 * Creates an HTTP request listener function backed by a {@link Router} instance.
 *
 * @param storageServiceOrDependencies - Optional custom {@link StorageService} or {@link RouterDependencies}.
 * @returns An asynchronous HTTP request handler compatible with Node.js `http.createServer`.
 *
 * @example
 * ```ts
 * import http from 'node:http';
 * import { createRouter } from './router.ts';
 *
 * const server = http.createServer(createRouter());
 * server.listen(8080);
 * ```
 */
export function createRouter(
  storageServiceOrDependencies: StorageService | RouterDependencies = createStorageService(),
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const router = new Router(storageServiceOrDependencies);
  return (req: IncomingMessage, res: ServerResponse) => router.handle(req, res);
}
