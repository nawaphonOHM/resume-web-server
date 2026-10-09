/**
 * Router types, interfaces, contracts, and baseline security header definitions.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppLogger } from '../logger/logger_types.ts';
import type { IAssetClassifier, IMimeTypeResolver } from '../mime/mime_types.ts';
import type { StorageService } from '../storage/storage_types.ts';

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
   * @param cleanPath - The sanitized POSIX request path.
   * @param res - The outgoing HTTP server response.
   * @param isHead - Whether the request was a HEAD method.
   * @returns `true` if the request was handled as a health check, `false` otherwise.
   */
  handle(cleanPath: string, res: ServerResponse, isHead: boolean): boolean;
}

/**
 * Contract for HTTP request dispatching and routing (Single Responsibility Principle).
 */
export interface IHttpRequestDispatcher {
  /**
   * Dispatches an incoming HTTP request through the security and routing pipeline.
   *
   * @param req - The incoming HTTP request message.
   * @param res - The outgoing HTTP server response.
   */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/**
 * Dependency injection options for initializing a {@link Router} instance.
 *
 * @remarks
 * Note: `cachePolicyResolver` is not exposed as an injectable option because cache policies
 * are derived directly from MIME classifications and asset hashing rules rather than independent strategy variation.
 */
export interface RouterDependencies {
  /**
   * Storage service implementation for static file streaming.
   */
  readonly storageService?: StorageService;

  /**
   * URL path sanitizer for traversal validation.
   */
  readonly pathSanitizer?: IPathSanitizer;

  /**
   * Policy for injecting baseline security headers.
   */
  readonly securityHeadersPolicy?: ISecurityHeadersPolicy;

  /**
   * Validator for incoming HTTP request methods.
   */
  readonly httpMethodValidator?: IHttpMethodValidator;

  /**
   * Handler for `/health` endpoint requests.
   */
  readonly healthCheckHandler?: IHealthCheckHandler;

  /**
   * MIME content-type resolver.
   */
  readonly mimeResolver?: IMimeTypeResolver;

  /**
   * Static asset classifier.
   */
  readonly assetClassifier?: IAssetClassifier;

  /**
   * Application logger for structured decision logging.
   */
  readonly logger?: AppLogger;
}
