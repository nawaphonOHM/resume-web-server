/**
 * Structured decision logging helpers for storage error classification.
 *
 * @packageDocumentation
 */

import {
  HTTP_STATUS_BAD_GATEWAY,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
} from '../http/http_status_codes.ts';
import type { AppLogger, DecisionLogPayload, LogLevel } from '../logger/logger_types.ts';
import {
  formatErrorReason,
  resolveErrorLevel,
  resolveMidStreamReason,
  resolveStandardChoice,
  withDefault,
} from './storage_error_reason.ts';

export interface ErrorClassificationInput {
  readonly is404: boolean;
  readonly fullPath: string;
  readonly notFoundStatusCode?: number;
  readonly isHead?: boolean;
  readonly headersSent?: boolean;
  readonly currentStatusCode?: number;
}

interface ClassificationResult {
  readonly payload: DecisionLogPayload;
  readonly statusCode: number;
}

interface ErrorCoreInput {
  readonly choice: string;
  readonly reason: string;
  readonly level: LogLevel;
  readonly statusCode: number;
  readonly path: string;
}

function makeErrorCore(input: ErrorCoreInput): DecisionLogPayload {
  const { choice, reason, level, statusCode, path } = input;
  return { action: 'ErrorClassifier', choice, reason, level, statusCode, path };
}

function finishErrorPayload(
  core: DecisionLogPayload,
  is404: boolean,
  isHead: boolean | undefined,
  headersSent: boolean,
): DecisionLogPayload {
  const withHead = isHead === undefined ? core : { ...core, isHead };
  if (headersSent) return { ...withHead, is404, headersSent: true };
  return { ...withHead, is404 };
}

function midStreamChoice(status: number): string {
  return `abort connection (headers already sent, status ${String(status)})`;
}

function buildMidStreamCore(input: ErrorClassificationInput, status: number): DecisionLogPayload {
  return makeErrorCore({
    choice: midStreamChoice(status),
    reason: resolveMidStreamReason(input.isHead, status),
    level: 'warn',
    statusCode: status,
    path: input.fullPath,
  });
}

function buildMidResult(input: ErrorClassificationInput): ClassificationResult {
  const status = withDefault(input.currentStatusCode, HTTP_STATUS_OK);
  const core = buildMidStreamCore(input, status);
  const payload = finishErrorPayload(core, input.is404, input.isHead, true);
  return { payload, statusCode: status };
}

function buildPreCore(
  input: ErrorClassificationInput,
  code: number,
  mapped: number,
): DecisionLogPayload {
  const choice = resolveStandardChoice(code);
  const reason = formatErrorReason(input.is404, mapped);
  const level = resolveErrorLevel(input.is404, mapped);
  return makeErrorCore({ choice, reason, level, statusCode: code, path: input.fullPath });
}

function buildPreResult(input: ErrorClassificationInput): ClassificationResult {
  const notFound = withDefault(input.notFoundStatusCode, HTTP_STATUS_NOT_FOUND);
  const status = input.is404 ? notFound : HTTP_STATUS_BAD_GATEWAY;
  const core = buildPreCore(input, status, notFound);
  const payload = finishErrorPayload(core, input.is404, input.isHead, false);
  return { payload, statusCode: status };
}

export function logStorageErrorClassification(
  appLogger: AppLogger,
  input: ErrorClassificationInput,
): { statusCode: number } {
  const headersSent = withDefault(input.headersSent, false);
  const result = headersSent ? buildMidResult(input) : buildPreResult(input);
  appLogger.decision(result.payload);
  return { statusCode: result.statusCode };
}
