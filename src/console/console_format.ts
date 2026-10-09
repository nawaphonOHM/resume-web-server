/**
 * Winston console output formatter.
 *
 * @packageDocumentation
 */

import winston from 'winston';
import { collectConsoleMetaParts } from './console_meta_collector.ts';
import { escapeCallStack, escapeForConsole } from './console_sanitizer.ts';
import { DECISION_SYMBOL, GENERATED_STACK_SYMBOL } from '../logger/logger_types.ts';
import { safeStringify } from '../safe_stringify.ts';

function formatBaseLogMessage(info: winston.Logform.TransformableInfo): string {
  const timestamp =
    typeof info['timestamp'] === 'string' ? info['timestamp'] : new Date().toISOString();
  const rawMessage = typeof info.message === 'string' ? info.message : safeStringify(info.message);
  const message = escapeForConsole(rawMessage);
  return `${timestamp} [${info.level}]: ${message}`;
}

function appendErrorDetail(line: string, info: winston.Logform.TransformableInfo): string {
  if (typeof info['errorDetail'] === 'string') {
    return `${line}\nError Detail: ${escapeForConsole(info['errorDetail'])}`;
  }
  return line;
}

function appendCallStack(line: string, info: winston.Logform.TransformableInfo): string {
  if (typeof info['callStack'] === 'string') {
    return `${line}\nCall Stack:\n${escapeCallStack(info['callStack'])}`;
  }
  return line;
}

function appendGeneratedErrorDetails(
  line: string,
  info: winston.Logform.TransformableInfo,
): string {
  if ((info as Record<symbol, unknown>)[GENERATED_STACK_SYMBOL] !== true) {
    return line;
  }
  return appendCallStack(appendErrorDetail(line, info), info);
}

function assembleConsoleLog(info: winston.Logform.TransformableInfo): string {
  const baseLine = formatBaseLogMessage(info);
  const isDecision = info[DECISION_SYMBOL as unknown as keyof typeof info] === true;
  const metaParts = collectConsoleMetaParts(info, isDecision);
  const fullLine = metaParts.length > 0 ? `${baseLine} | ${metaParts.join(' | ')}` : baseLine;
  return appendGeneratedErrorDetails(fullLine, info);
}

/**
 * Winston format that renders human-readable console log lines with escaped characters and un-truncated stack traces.
 */
export const formatConsoleOutput = winston.format.printf(assembleConsoleLog);
