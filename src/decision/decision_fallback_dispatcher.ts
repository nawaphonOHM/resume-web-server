/**
 * Fallback dispatching for minimal logger objects without Winston / AppLogger contracts.
 *
 * @packageDocumentation
 */

import type winston from 'winston';
import type { AppLogger, GenericLogger } from '../logger/logger_types.ts';
import type { DecisionDispatchContext } from './decision_payload_builder.ts';

type TargetLogger = AppLogger | winston.Logger | GenericLogger;

type LevelMethod = (msg: string, ...extra: unknown[]) => void;

function invokeLevelMethod(
  target: TargetLogger,
  method: unknown,
  ctx: DecisionDispatchContext,
): void {
  (method as LevelMethod).call(target, ctx.message, ...ctx.extraArgs);
}

function dispatchFallbackWarn(target: TargetLogger, ctx: DecisionDispatchContext): void {
  if (typeof target.warn === 'function') {
    target.warn(ctx.message, ...ctx.extraArgs);
  } else {
    target.info(`[WARN] ${ctx.message}`, ...ctx.extraArgs);
  }
}

function dispatchFallbackError(target: TargetLogger, ctx: DecisionDispatchContext): void {
  if (typeof target.error === 'function') {
    target.error(ctx.message, ...ctx.extraArgs);
  } else {
    target.info(`[ERROR] ${ctx.message}`, ...ctx.extraArgs);
  }
}

function dispatchOptionalLevel(target: TargetLogger, ctx: DecisionDispatchContext): void {
  const method = (target as unknown as Record<string, unknown>)[ctx.level];
  if (typeof method === 'function') invokeLevelMethod(target, method, ctx);
}

function dispatchWarningOrError(target: TargetLogger, ctx: DecisionDispatchContext): void {
  if (ctx.level === 'error') {
    dispatchFallbackError(target, ctx);
  } else {
    dispatchFallbackWarn(target, ctx);
  }
}

function isWarningOrError(level: string): boolean {
  return level === 'error' || level === 'warn';
}

export function dispatchFallbackLevel(target: TargetLogger, ctx: DecisionDispatchContext): void {
  if (isWarningOrError(ctx.level)) {
    dispatchWarningOrError(target, ctx);
  } else if (ctx.level === 'info') {
    target.info(ctx.message, ...ctx.extraArgs);
  } else {
    dispatchOptionalLevel(target, ctx);
  }
}
