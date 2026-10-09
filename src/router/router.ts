/**
 * HTTP request router subsystem re-exporting routing components, validation, and dispatcher.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  resolveRouterDependencies,
  type ResolvedRouterDependencies,
} from './router_deps_resolver.ts';
import { handleRequestPipeline } from './router_pipeline.ts';
import type { IHttpRequestDispatcher, RouterDependencies } from './router_types.ts';
import { createStorageService } from '../storage/storage.ts';
import type { StorageService } from '../storage/storage_types.ts';

export {
  SECURITY_HEADERS,
  type HealthPayload,
  type PathValidationResult,
  type IPathSanitizer,
  type ISecurityHeadersPolicy,
  type IHttpMethodValidator,
  type IHealthStatusProvider,
  type IHealthCheckHandler,
  type IHttpRequestDispatcher,
  type RouterDependencies,
} from './router_types.ts';

export { sanitizeUrlForLogging } from '../url_logger_sanitizer.ts';

export {
  DefenseInDepthPathSanitizer,
  defaultPathSanitizer,
  validateAndSanitizePath,
} from '../path/path_sanitizer.ts';

export { StandardSecurityHeadersPolicy } from '../security_headers_policy.ts';
export { StandardHttpMethodValidator } from '../http/http_method_validator.ts';

export { SystemHealthStatusProvider, DefaultHealthCheckHandler } from '../health_check_handler.ts';

/**
 * HTTP Request Router coordinating security policies, sanitization, MIME resolution, and storage streaming.
 *
 * @remarks
 * Dispatches requests through a 7-step pipeline:
 * 1. Inject baseline security headers into the response.
 * 2. Validate request method (permits `GET` and `HEAD`; responds `405 Method Not Allowed` otherwise).
 * 3. Validate and sanitize request path against traversal attacks (responds `400 Bad Request` if invalid).
 * 4. Dispatch `/health` endpoint checks.
 * 5. Resolve MIME type and cache policy based on file extension and content-hash fingerprinting.
 * 6. Stream static asset from storage, or fall back to SPA root (`index.html`).
 * 7. Catch unhandled errors and return `500 Internal Server Error` if headers have not yet been sent.
 */
export class Router implements IHttpRequestDispatcher {
  private readonly deps: ResolvedRouterDependencies;

  /**
   * Creates a new `Router` instance.
   *
   * @param storageServiceOrDependencies - Custom {@link StorageService} or {@link RouterDependencies} options object.
   * @param dependencies - Optional secondary dependencies object when the first parameter is a storage service.
   */
  public constructor(
    storageServiceOrDependencies?: StorageService | RouterDependencies,
    dependencies?: RouterDependencies,
  ) {
    this.deps = resolveRouterDependencies(storageServiceOrDependencies, dependencies);
  }

  /**
   * Handles an incoming HTTP request through the full security and routing pipeline.
   *
   * @param req - The incoming HTTP request message.
   * @param res - The outgoing HTTP server response.
   */
  public async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await handleRequestPipeline(this.deps, req, res);
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
