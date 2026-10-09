/**
 * Winston formatter for structured decision telemetry.
 *
 * @packageDocumentation
 */

import winston from 'winston';
import { DECISION_LOG_TYPE, DECISION_SYMBOL } from '../logger/logger_types.ts';
import { safeStringify } from '../safe_stringify.ts';

function formatDecisionMessage(info: winston.Logform.TransformableInfo): string {
  const action = safeStringify(info['action']);
  const choice = safeStringify(info['choice']);
  const reason = safeStringify(info['reason']);
  return `Decision [${action}] | Choice: ${choice} | Reason: ${reason}`;
}

function isBlankMessage(message: unknown): boolean {
  return typeof message !== 'string' || message.length === 0;
}

function populateDecisionInfo(info: winston.Logform.TransformableInfo): void {
  info['logType'] = DECISION_LOG_TYPE;
  if (isBlankMessage(info.message)) {
    info.message = formatDecisionMessage(info);
  }
}

function applyDecisionTransform(
  info: winston.Logform.TransformableInfo,
): winston.Logform.TransformableInfo {
  if (info[DECISION_SYMBOL as unknown as keyof typeof info] === true) {
    populateDecisionInfo(info);
  }
  return info;
}

/**
 * Winston format that handles structured decision telemetry payloads.
 */
export const formatDecision = winston.format(applyDecisionTransform);
