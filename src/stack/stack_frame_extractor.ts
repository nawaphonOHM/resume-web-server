/**
 * Call stack frame and header extraction utilities.
 *
 * @packageDocumentation
 */

import { escapeForConsole } from '../console/console_sanitizer.ts';
import { sanitizeErrorMessage } from '../error/error_message_sanitizer.ts';

export interface RawErrorInfo {
  readonly name: string;
  readonly message: string;
  readonly rawStack: string;
}

function resolveErrorName(name: unknown): string {
  return typeof name === 'string' && name.length > 0 ? name : 'Error';
}

function extractFromErrorInstance(err: Error): RawErrorInfo {
  const name = resolveErrorName(err.name);
  const message = typeof err.message === 'string' ? err.message : '';
  const rawStack = typeof err.stack === 'string' ? err.stack : '';
  return { name, message, rawStack };
}

function extractFromErrorObject(obj: Record<string, unknown>, raw: unknown): RawErrorInfo {
  const name = resolveErrorName(obj['name']);
  const message = typeof obj['message'] === 'string' ? obj['message'] : sanitizeErrorMessage(raw);
  const rawStack = typeof obj['stack'] === 'string' ? obj['stack'] : '';
  return { name, message, rawStack };
}

export function isObjectRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null;
}

export function extractRawErrorInfo(err: unknown): RawErrorInfo {
  if (err instanceof Error) {
    return extractFromErrorInstance(err);
  }
  if (isObjectRecord(err)) {
    return extractFromErrorObject(err, err);
  }
  return { name: 'Error', message: sanitizeErrorMessage(err), rawStack: '' };
}

function formatErrorHeader(name: string, message: string): string {
  if (message.length > 0) {
    return `${escapeForConsole(name)}: ${escapeForConsole(message)}`;
  }
  return escapeForConsole(name);
}

function formatSingleFrame(line: string): string {
  const match = /^([ \t]*)(.*)$/.exec(line);
  if (match) {
    return match[1] + escapeForConsole(match[2]);
  }
  return escapeForConsole(line);
}

function extractFrameLines(rawStack: string): string[] {
  if (rawStack.length === 0) {
    return [];
  }
  return rawStack
    .split(/\r?\n/)
    .filter((line) => /^[ \t]+at\s+/.test(line))
    .map(formatSingleFrame);
}

export function assembleTraceHeader(info: RawErrorInfo): string {
  const header = formatErrorHeader(info.name, info.message);
  const frames = extractFrameLines(info.rawStack);
  return frames.length > 0 ? `${header}\n${frames.join('\n')}` : header;
}
