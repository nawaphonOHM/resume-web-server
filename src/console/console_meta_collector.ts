/**
 * Console metadata filtering and formatting utilities.
 *
 * @packageDocumentation
 */

import type winston from 'winston';
import { escapeForConsole } from './console_sanitizer.ts';
import { safeStringify } from '../safe_stringify.ts';

const IGNORED_CONSOLE_KEYS = new Set([
  'level',
  'message',
  'timestamp',
  'errorDetail',
  'callStack',
  'error',
  'err',
  'splat',
  'logType',
  'additionalErrors',
]);

interface MetaContext {
  readonly info: winston.Logform.TransformableInfo;
  readonly isDecision: boolean;
}

function isDecisionMetaKey(key: string): boolean {
  return key === 'action' || key === 'choice' || key === 'reason';
}

function isBenignErrorField(key: string, info: winston.Logform.TransformableInfo): boolean {
  return (key === 'error' || key === 'err') && info['errorDetail'] === undefined;
}

function isIgnoredKey(key: string, info: winston.Logform.TransformableInfo): boolean {
  if (IGNORED_CONSOLE_KEYS.has(key)) {
    return !isBenignErrorField(key, info);
  }
  return false;
}

function shouldSkipMetaKey(
  key: string,
  info: winston.Logform.TransformableInfo,
  isDecision: boolean,
): boolean {
  if (isIgnoredKey(key, info)) {
    return true;
  }
  return isDecision && isDecisionMetaKey(key);
}

function resolveMetaKey(key: string): string {
  const displayKey = key === 'metaMessage' ? 'message' : key;
  return displayKey.charAt(0).toUpperCase() + displayKey.slice(1);
}

function formatMetaEntry(key: string, value: unknown): string {
  const formattedKey = resolveMetaKey(key);
  const formattedVal = safeStringify(value);
  return `${escapeForConsole(formattedKey)}: ${escapeForConsole(formattedVal)}`;
}

function formatAllowedMetaEntry(key: string, value: unknown, ctx: MetaContext): string | undefined {
  if (shouldSkipMetaKey(key, ctx.info, ctx.isDecision)) {
    return undefined;
  }
  return formatMetaEntry(key, value);
}

function appendMetaEntry(parts: string[], entry: string | undefined): void {
  if (entry !== undefined) {
    parts.push(entry);
  }
}

function fillMetaParts(
  parts: string[],
  info: winston.Logform.TransformableInfo,
  ctx: MetaContext,
): void {
  for (const [key, value] of Object.entries(info)) {
    appendMetaEntry(parts, formatAllowedMetaEntry(key, value, ctx));
  }
}

/**
 * Collects and formats non-ignored metadata key-value pairs for console log serialization.
 *
 * @param info - Winston log entry.
 * @param isDecision - True if log entry is a structured decision telemetry record.
 * @returns Array of formatted key-value strings.
 */
export function collectConsoleMetaParts(
  info: winston.Logform.TransformableInfo,
  isDecision: boolean,
): string[] {
  const metaParts: string[] = [];
  fillMetaParts(metaParts, info, { info, isDecision });
  return metaParts;
}
