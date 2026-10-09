/**
 * Decision telemetry logging helper functions.
 *
 * @packageDocumentation
 */

import type winston from 'winston';
import type { AppLogger, DecisionLogPayload, GenericLogger } from '../logger/logger_types.ts';
import { buildDecisionContext, type DecisionDispatchContext } from './decision_payload_builder.ts';
import { dispatchFallbackLevel } from './decision_fallback_dispatcher.ts';

type TargetLogger = AppLogger | winston.Logger | GenericLogger;

function dispatchNativeDecision(target: TargetLogger, payload: DecisionLogPayload): boolean {
  if (typeof (target as AppLogger).decision === 'function') {
    (target as AppLogger).decision(payload);
    return true;
  }
  return false;
}

function dispatchWinstonLog(target: TargetLogger, ctx: DecisionDispatchContext): boolean {
  if (typeof (target as winston.Logger).log === 'function') {
    (target as winston.Logger).log(ctx.level, ctx.message, ctx.data);
    return true;
  }
  return false;
}

function dispatchFallbackPipeline(target: TargetLogger, payload: DecisionLogPayload): void {
  const ctx = buildDecisionContext(payload);
  if (!dispatchWinstonLog(target, ctx)) {
    dispatchFallbackLevel(target, ctx);
  }
}

/**
 * Dispatches a structured decision telemetry record to an {@link AppLogger}, standard Winston logger,
 * or minimal duck-typed logger interface.
 *
 * @param targetLogger - Logger target.
 * @param payload - Decision payload specifying action, choice, reason, level, and metadata.
 */
export function logDecision(
  targetLogger: AppLogger | winston.Logger | GenericLogger,
  payload: DecisionLogPayload,
): void {
  if (!dispatchNativeDecision(targetLogger, payload)) {
    dispatchFallbackPipeline(targetLogger, payload);
  }
}
