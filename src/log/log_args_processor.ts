/**
 * Processing and normalization of log messages and variable argument lists.
 *
 * @packageDocumentation
 */

import { isErrorObject } from '../error/error_inspector.ts';
import { safeStringify } from '../safe_stringify.ts';
import { collectMetaItem, createMetaState, finalizePayload } from './log_meta_collector.ts';

export interface ProcessedLogArgs {
  readonly logMessage: string;
  readonly payload: Record<string, unknown>;
}

function getRecordName(rec: Record<string, unknown>): string {
  return typeof rec['name'] === 'string' ? rec['name'] : 'Error';
}

function extractErrorObjectMessage(rec: Record<string, unknown>): string {
  if (typeof rec['message'] === 'string' && rec['message'].length > 0) {
    return rec['message'];
  }
  return getRecordName(rec);
}

function resolveErrorMessage(err: Error | Record<string, unknown>): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  return extractErrorObjectMessage(err);
}

function isErrorLike(message: string | Error): boolean {
  return message instanceof Error || isErrorObject(message);
}

function resolveTextMessage(message: string | Error): string {
  return typeof message === 'string' ? message : safeStringify(message);
}

function resolveInitialMessage(message: string | Error): {
  readonly logMsg: string;
  readonly initialErr?: unknown;
} {
  if (isErrorLike(message)) {
    const errObj = message as Error | Record<string, unknown>;
    return { logMsg: resolveErrorMessage(errObj), initialErr: message };
  }
  return { logMsg: resolveTextMessage(message) };
}

export function processLogArgs(
  message: string | Error,
  meta: readonly unknown[],
): ProcessedLogArgs {
  const { logMsg, initialErr } = resolveInitialMessage(message);
  const state = createMetaState(initialErr);
  for (const item of meta) collectMetaItem(item, state);
  return { logMessage: logMsg, payload: finalizePayload(state) };
}
