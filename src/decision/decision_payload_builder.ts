/**
 * Decision payload formatting and sanitization builder.
 *
 * @packageDocumentation
 */

import {
  DECISION_LOG_TYPE,
  DECISION_SYMBOL,
  type DecisionLogPayload,
  type LogLevel,
  resolveLogLevel,
} from '../logger/logger_types.ts';

export interface DecisionDispatchContext {
  readonly level: LogLevel;
  readonly message: string;
  readonly data: Record<string, unknown>;
  readonly extraArgs: readonly unknown[];
}

function sanitizeDecisionKey(k: string, v: unknown, clean: Record<string, unknown>): void {
  if (k === 'message') {
    clean['metaMessage'] = v;
  } else if (k !== 'logType') {
    clean[k] = v;
  }
}

export function sanitizeDecisionMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) sanitizeDecisionKey(k, v, clean);
  return clean;
}

export function buildDecisionRecord(payload: DecisionLogPayload): Record<string, unknown> {
  const { action, choice, reason, level: _l, ...meta } = payload;
  const res: Record<string, unknown> = { [DECISION_SYMBOL]: true, action, choice, reason };
  Object.assign(res, sanitizeDecisionMeta(meta), { logType: DECISION_LOG_TYPE });
  return res;
}

function extractExtraArgs(meta: Record<string, unknown>): readonly unknown[] {
  return meta['error'] !== undefined ? [meta['error']] : [];
}

export function buildDecisionContext(payload: DecisionLogPayload): DecisionDispatchContext {
  const { action, choice, reason, level = 'info', ...meta } = payload;
  const message = `Decision [${action}] | Choice: ${choice} | Reason: ${reason}`;
  return {
    level: resolveLogLevel(level),
    message,
    data: buildDecisionRecord(payload),
    extraArgs: extractExtraArgs(meta),
  };
}
