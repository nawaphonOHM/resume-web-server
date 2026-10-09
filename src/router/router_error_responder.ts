/**
 * Error response writers for the router subsystem.
 *
 * @packageDocumentation
 */

import type { ServerResponse } from 'node:http';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
} from '../http/http_status_codes.ts';

export function write400BadRequest(res: ServerResponse): void {
  res.statusCode = HTTP_STATUS_BAD_REQUEST;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end('Bad Request');
}

function isResponseWritable(res: ServerResponse): boolean {
  return !res.headersSent && !res.destroyed && !res.writableEnded;
}

export function write500InternalServerError(res: ServerResponse): void {
  if (isResponseWritable(res)) {
    res.statusCode = HTTP_STATUS_INTERNAL_SERVER_ERROR;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end('Internal Server Error');
  }
}
