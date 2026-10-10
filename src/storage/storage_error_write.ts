/**
 * HTTP error payload writers for storage streaming failures.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import { isResponseWritable } from '../http/http_response_state.ts';
import {
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
} from '../http/http_status_codes.ts';

function clearStaleHeaders(res: ServerResponse): void {
  res.removeHeader('Content-Length');
  res.removeHeader('ETag');
  res.removeHeader('Content-Encoding');
  res.removeHeader('Last-Modified');
}

function getErrorBody(statusCode: number): string {
  if (statusCode === HTTP_STATUS_NOT_FOUND) return 'Not Found';
  if (statusCode === HTTP_STATUS_INTERNAL_SERVER_ERROR) return 'Internal Server Error';
  return 'Bad Gateway';
}

export function sendErrorPayload(res: ServerResponse, statusCode: number): void {
  if (!isResponseWritable(res)) return;
  clearStaleHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(getErrorBody(statusCode));
}

export function destroyIfWritable(res: ServerResponse): void {
  if (!res.writableEnded && !res.destroyed) res.destroy();
}
