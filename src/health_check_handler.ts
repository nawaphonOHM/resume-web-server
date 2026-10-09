/**
 * Health check handler responding with system status and uptime.
 *
 * @packageDocumentation
 */

import { Buffer } from 'node:buffer';
import type { ServerResponse } from 'node:http';
import { HTTP_STATUS_OK } from './http/http_status_codes.ts';
import type { AppLogger, DecisionLogPayload } from './logger/logger_types.ts';
import type {
  HealthPayload,
  IHealthCheckHandler,
  IHealthStatusProvider,
} from './router/router_types.ts';

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

interface HealthDecisionParams {
  readonly path: string;
  readonly status: string;
  readonly isHead: boolean;
}

function makeHealthPayload(p: HealthDecisionParams): DecisionLogPayload {
  const reason = 'Exact match on health check endpoint path';
  const meta = { level: 'debug' as const, path: p.path, status: p.status, isHead: p.isHead };
  return { action: 'HealthCheckHandler', choice: 'handle /health endpoint', reason, ...meta };
}

function writeHeaders(res: ServerResponse, len: number): void {
  res.statusCode = HTTP_STATUS_OK;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Length', String(len));
}

function writeHealthResponse(res: ServerResponse, json: string, isHead: boolean): void {
  writeHeaders(res, Buffer.byteLength(json));
  if (isHead) res.end();
  else res.end(json);
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
   * @param provider - Health status provider instance.
   * @param logger - Optional injected application logger.
   */
  public constructor(
    provider: IHealthStatusProvider = new SystemHealthStatusProvider(),
    logger?: AppLogger,
  ) {
    this.provider = provider;
    this.logger = logger;
  }

  private writeAndLog(cleanPath: string, res: ServerResponse, isHead: boolean): void {
    const payload = this.provider.getHealthStatus();
    if (this.logger) {
      this.logger.decision(makeHealthPayload({ path: cleanPath, status: payload.status, isHead }));
    }
    writeHealthResponse(res, JSON.stringify(payload), isHead);
  }

  /**
   * Handles `/health` check requests.
   *
   * @param cleanPath - The sanitized POSIX request path.
   * @param res - The outgoing HTTP server response.
   * @param isHead - Whether the request was a HEAD method.
   * @returns `true` if the request was handled, `false` otherwise.
   */
  public handle(cleanPath: string, res: ServerResponse, isHead: boolean): boolean {
    if (cleanPath !== 'health') return false;
    this.writeAndLog(cleanPath, res, isHead);
    return true;
  }
}
