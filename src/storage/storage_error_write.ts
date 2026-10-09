/**
 * HTTP error payload writers for storage streaming failures.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import { HTTP_STATUS_NOT_FOUND } from '../http/http_status_codes.ts';

function clearStaleHeaders(res: ServerResponse): void {
  res.removeHeader('Content-Length');
  res.removeHeader('ETag');
  res.removeHeader('Content-Encoding');
  res.removeHeader('Last-Modified');
}

function getErrorBody(statusCode: number): string {
  return statusCode === HTTP_STATUS_NOT_FOUND ? 'Not Found' : 'Bad Gateway';
}

export function sendErrorPayload(res: ServerResponse, statusCode: number): void {
  if (res.destroyed || res.writableEnded) return;
  clearStaleHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(getErrorBody(statusCode));
}

export function destroyIfWritable(res: ServerResponse): void {
  if (!res.writableEnded && !res.destroyed) res.destroy();
}
