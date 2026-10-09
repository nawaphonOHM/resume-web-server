/**
 * Winston formatter for Java-style error formatting and comprehensive payload sanitization.
 *
 * @packageDocumentation
 */

import winston from 'winston';
import { formatErrorDetail } from '../error/error_detail_formatter.ts';
import {
  buildFullCallStack,
  renameUntrustedStackFields,
  resolveFoundError,
} from '../error/error_field_detector.ts';
import { sanitizeErrorForLog } from '../error/error_sanitizer.ts';
import { DECISION_SYMBOL, GENERATED_STACK_SYMBOL } from '../logger/logger_types.ts';
import { sanitizeAllErrorsInValue } from '../value_error_sanitizer.ts';

function sanitizeErrorProperties(info: winston.Logform.TransformableInfo): void {
  if (info['error'] !== undefined) {
    info['error'] = sanitizeErrorForLog(info['error']);
  }
  if (info['err'] !== undefined) {
    info['err'] = sanitizeErrorForLog(info['err']);
  }
}

function attachErrorStackFields(
  info: winston.Logform.TransformableInfo,
  foundError: unknown,
): void {
  info['errorDetail'] = formatErrorDetail(foundError);
  info['callStack'] = buildFullCallStack(foundError, info['additionalErrors']);
  (info as Record<symbol, unknown>)[GENERATED_STACK_SYMBOL] = true;
  sanitizeErrorProperties(info);
}

function sanitizeSingleInfoField(
  info: winston.Logform.TransformableInfo,
  k: string,
  v: unknown,
): void {
  if (k !== 'errorDetail' && k !== 'callStack') {
    info[k] = sanitizeAllErrorsInValue(v);
  }
}

function sanitizeInfoFields(info: winston.Logform.TransformableInfo): void {
  for (const [k, v] of Object.entries(info)) {
    sanitizeSingleInfoField(info, k, v);
  }
}

function processFoundError(info: winston.Logform.TransformableInfo, isDecision: boolean): void {
  const foundError = resolveFoundError(info, isDecision);
  if (foundError !== null) {
    attachErrorStackFields(info, foundError);
  }
}

function applyJavaStyleErrorTransform(
  info: winston.Logform.TransformableInfo,
): winston.Logform.TransformableInfo {
  renameUntrustedStackFields(info);
  const isDecision = info[DECISION_SYMBOL as unknown as keyof typeof info] === true;
  processFoundError(info, isDecision);
  sanitizeInfoFields(info);
  return info;
}

/**
 * Winston format that inspects log entries for Error instances or error-like objects,
 * populates un-truncated Java-style `callStack` and `errorDetail` fields, and sanitizes payload fields.
 */
export const formatJavaStyleError = winston.format(applyJavaStyleErrorTransform);
