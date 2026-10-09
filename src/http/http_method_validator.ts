/**
 * HTTP method validation ensuring incoming requests use allowed methods (GET and HEAD).
 *
 * @packageDocumentation
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HTTP_STATUS_METHOD_NOT_ALLOWED } from './http_status_codes.ts';
import type { AppLogger, DecisionLogPayload } from '../logger/logger_types.ts';
import type { IHttpMethodValidator } from '../router/router_types.ts';
import { sanitizeUrlForLogging } from '../url_logger_sanitizer.ts';

const ALLOWED_METHODS: readonly string[] = Object.freeze(['GET', 'HEAD']);

function rejectReason(m: string | undefined): string {
  return `Method '${m ?? 'UNKNOWN'}' is not allowed (only GET and HEAD permitted)`;
}

function rejectMeta(req: IncomingMessage) {
  const meta = { level: 'debug' as const, method: req.method, allowedMethods: 'GET, HEAD' };
  return {
    ...meta,
    statusCode: HTTP_STATUS_METHOD_NOT_ALLOWED,
    path: sanitizeUrlForLogging(req.url),
  };
}

function makeRejectPayload(req: IncomingMessage): DecisionLogPayload {
  return {
    action: 'HttpMethodValidator',
    choice: 'reject request (405)',
    reason: rejectReason(req.method),
    ...rejectMeta(req),
  };
}

function makePermitPayload(method: string): DecisionLogPayload {
  const reason = `HTTP method '${method}' is allowed (GET/HEAD permitted)`;
  return {
    action: 'HttpMethodValidator',
    choice: 'permit request',
    reason,
    level: 'debug',
    method,
  };
}

function write405Response(res: ServerResponse): void {
  res.statusCode = HTTP_STATUS_METHOD_NOT_ALLOWED;
  res.setHeader('Allow', 'GET, HEAD');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end('Method Not Allowed');
}

/**
 * Validates incoming HTTP request methods, restricting access exclusively to `GET` and `HEAD`.
 *
 * @remarks
 * Sends a `405 Method Not Allowed` response with the `Allow: GET, HEAD` header when a disallowed method is encountered.
 */
export class StandardHttpMethodValidator implements IHttpMethodValidator {
  /**
   * Optional injected application logger.
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

  private reject(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.logger) this.logger.decision(makeRejectPayload(req));
    write405Response(res);
    return false;
  }

  private permit(method: string): boolean {
    if (this.logger) this.logger.decision(makePermitPayload(method));
    return true;
  }

  /**
   * Validates that the request method is either `GET` or `HEAD`.
   *
   * @param req - The incoming HTTP request.
   * @param res - The outgoing HTTP server response.
   * @returns `true` if valid (`GET` or `HEAD`), `false` if rejected and 405 response sent.
   */
  public validate(req: IncomingMessage, res: ServerResponse): boolean {
    const method = req.method ? req.method.toUpperCase() : '';
    if (!ALLOWED_METHODS.includes(method)) {
      return this.reject(req, res);
    }
    return this.permit(method);
  }
}
