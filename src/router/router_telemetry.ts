/**
 * Decision and error telemetry logging helpers for the HTTP request router.
 *
 * @packageDocumentation
 */

import type { IncomingMessage } from 'node:http';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_METHOD_NOT_ALLOWED,
} from '../http/http_status_codes.ts';
import type { AppLogger, DecisionLogPayload } from '../logger/logger_types.ts';
import { sanitizeUrlForLogging } from '../url_logger_sanitizer.ts';

export interface StaticAssetLogParams {
  readonly path: string;
  readonly contentType: string;
  readonly isHashed: boolean;
  readonly cacheControl: string;
  readonly isHead: boolean;
}

function makeMethodMeta(req: IncomingMessage) {
  const reason = `HTTP method '${req.method ?? 'UNKNOWN'}' is not allowed (only GET and HEAD permitted)`;
  const meta = { reason, level: 'warn' as const, method: req.method, allowedMethods: 'GET, HEAD' };
  return {
    ...meta,
    statusCode: HTTP_STATUS_METHOD_NOT_ALLOWED,
    path: sanitizeUrlForLogging(req.url),
  };
}

function makeMethodRejectPayload(req: IncomingMessage): DecisionLogPayload {
  return { action: 'Router', choice: 'reject request (405)', ...makeMethodMeta(req) };
}

export function logMethodReject(logger: AppLogger, req: IncomingMessage): void {
  logger.decision(makeMethodRejectPayload(req));
}

function makePathMeta(url: string | undefined, error?: string) {
  const reason = error ?? 'Invalid or malicious URL path detected';
  return {
    reason,
    level: 'warn' as const,
    path: sanitizeUrlForLogging(url),
    statusCode: HTTP_STATUS_BAD_REQUEST,
  };
}

export function logPathReject(logger: AppLogger, url: string | undefined, err?: string): void {
  logger.decision({ action: 'Router', choice: 'reject request (400)', ...makePathMeta(url, err) });
}

function makeStaticMeta(p: StaticAssetLogParams) {
  const reason = `Path has static asset extension with MIME type '${p.contentType}' and Cache-Control '${p.cacheControl}'`;
  const m1 = { reason, level: 'info' as const, path: p.path, contentType: p.contentType };
  return { ...m1, isHashed: p.isHashed, cacheControl: p.cacheControl, isHead: p.isHead };
}

export function logStaticAssetDecision(logger: AppLogger, p: StaticAssetLogParams): void {
  logger.decision({
    action: 'Router',
    choice: `stream static asset '${p.path}'`,
    ...makeStaticMeta(p),
  });
}

function makeSpaPayload(path: string, isHead: boolean): DecisionLogPayload {
  const reason = `Path '${path}' has no static asset extension, routing to SPA entrypoint`;
  const meta = { level: 'info' as const, path, fallbackTarget: 'index.html', isHead };
  return { action: 'Router', choice: 'SPA fallback (index.html)', reason, ...meta };
}

export function logSpaFallbackDecision(logger: AppLogger, path: string, isHead: boolean): void {
  logger.decision(makeSpaPayload(path, isHead));
}

export function logUnhandledRouterError(
  logger: AppLogger,
  req: IncomingMessage,
  err: unknown,
): void {
  const safeUrl = sanitizeUrlForLogging(req.url);
  const meta = { path: safeUrl, method: req.method, statusCode: HTTP_STATUS_INTERNAL_SERVER_ERROR };
  logger.error('Unhandled router error while processing request', err, meta);
}
