/**
 * Request validation helpers for HTTP methods and path sanitization.
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResolvedRouterDependencies } from './router_deps_resolver.ts';
import { write400BadRequest } from './router_error_responder.ts';
import { logMethodReject, logPathReject } from './router_telemetry.ts';

function cleanUrlPath(rawPath: string): string {
  return rawPath.replace(/^\/+|\/+$/g, '');
}

export function isHeadMethod(req: IncomingMessage): boolean {
  return typeof req.method === 'string' && req.method.toUpperCase() === 'HEAD';
}

function onInvalidPath(
  deps: ResolvedRouterDependencies,
  req: IncomingMessage,
  res: ServerResponse,
  err?: string,
): void {
  logPathReject(deps.logger, req.url, err);
  write400BadRequest(res);
}

/**
 * Validates the incoming request URL against traversal and extension allowlists
 * via the configured path sanitizer, and returns the cleaned path.
 *
 * @param deps - Resolved router dependencies including path sanitizer and logger.
 * @param req - Incoming HTTP request message.
 * @param res - HTTP server response for writing error responses if validation fails.
 * @returns Cleaned relative URL path if valid; `undefined` if validation failed and 400 was written.
 */
export function validateAndExtractPath(
  deps: ResolvedRouterDependencies,
  req: IncomingMessage,
  res: ServerResponse,
): string | undefined {
  const v = deps.pathSanitizer.validateAndSanitize(req.url);
  if (v.valid) return cleanUrlPath(v.path);
  onInvalidPath(deps, req, res, v.error);
  return undefined;
}

export function validateMethod(
  deps: ResolvedRouterDependencies,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (deps.httpMethodValidator.validate(req, res)) return true;
  logMethodReject(deps.logger, req);
  return false;
}

export function prepareRequest(
  deps: ResolvedRouterDependencies,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  deps.securityHeadersPolicy.applyHeaders(res);
  return validateMethod(deps, req, res);
}
