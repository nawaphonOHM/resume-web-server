/**
 * Error field extraction and untrusted stack field isolation for Winston loggers.
 *
 * @packageDocumentation
 */

import type winston from 'winston';
import { isErrorObject, isPotentialError } from './error_inspector.ts';
import { formatJavaStyleStackTrace } from '../java/java_stack_formatter.ts';
import { GENERATED_STACK_SYMBOL } from '../logger/logger_types.ts';

function renameUntrustedCallStack(info: winston.Logform.TransformableInfo): void {
  if (info['callStack'] !== undefined) {
    info['userCallStack'] = info['callStack'];
    delete info['callStack'];
  }
}

function renameUntrustedErrorDetail(info: winston.Logform.TransformableInfo): void {
  if (info['errorDetail'] !== undefined) {
    info['userErrorDetail'] = info['errorDetail'];
    delete info['errorDetail'];
  }
}

/**
 * Renames caller-supplied `callStack` and `errorDetail` metadata keys to prevent log forgery.
 *
 * @param info - Winston log entry.
 */
export function renameUntrustedStackFields(info: winston.Logform.TransformableInfo): void {
  if (info[GENERATED_STACK_SYMBOL as unknown as keyof typeof info] !== true) {
    renameUntrustedCallStack(info);
    renameUntrustedErrorDetail(info);
  }
}

function isDecisionErrorCandidate(err: unknown): boolean {
  if (!err) {
    return false;
  }
  return err instanceof Error || isErrorObject(err);
}

function findDecisionError(info: winston.Logform.TransformableInfo): unknown {
  if (isDecisionErrorCandidate(info['error'])) {
    return info['error'];
  }
  return isDecisionErrorCandidate(info['err']) ? info['err'] : null;
}

function findFirstErrorObject(items: unknown[]): unknown {
  for (const item of items) {
    if (isErrorObject(item)) {
      return item;
    }
  }
  return null;
}

function findErrorFromSplat(info: winston.Logform.TransformableInfo): unknown {
  const splat = info[Symbol.for('splat') as unknown as keyof typeof info];
  return Array.isArray(splat) ? findFirstErrorObject(splat) : null;
}

function extractPotentialError(val: unknown): unknown {
  return val !== undefined && isPotentialError(val) ? val : null;
}

function findStandardError(info: winston.Logform.TransformableInfo): unknown {
  const fromError = extractPotentialError(info['error']);
  if (fromError !== null) {
    return fromError;
  }
  const fromErr = extractPotentialError(info['err']);
  return fromErr !== null ? fromErr : findErrorFromSplat(info);
}

/**
 * Resolves the primary error object attached to a log entry.
 *
 * @param info - Winston log entry.
 * @param isDecision - True if log entry is a structured decision telemetry record.
 * @returns Found error object or null.
 */
export function resolveFoundError(
  info: winston.Logform.TransformableInfo,
  isDecision: boolean,
): unknown {
  return isDecision ? findDecisionError(info) : findStandardError(info);
}

function appendAdditionalError(stack: string, extra: unknown): string {
  if (extra !== null && extra !== undefined) {
    return `${stack}\n\nAdditional Error:\n${formatJavaStyleStackTrace(extra)}`;
  }
  return stack;
}

function appendExtraErrors(stack: string, extras: unknown[]): string {
  let full = stack;
  for (const extra of extras) {
    full = appendAdditionalError(full, extra);
  }
  return full;
}

/**
 * Formats full Java-style call stack including any additional errors attached to the entry.
 *
 * @param foundError - Primary error object.
 * @param additionalErrors - Optional list of additional errors.
 * @returns Full multi-error Java-style stack trace.
 */
export function buildFullCallStack(foundError: unknown, additionalErrors: unknown): string {
  const baseStack = formatJavaStyleStackTrace(foundError);
  if (Array.isArray(additionalErrors) && additionalErrors.length > 0) {
    return appendExtraErrors(baseStack, additionalErrors);
  }
  return baseStack;
}
