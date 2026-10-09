/**
 * Metadata collection and payload aggregation for application logging.
 *
 * @packageDocumentation
 */

import { isErrorObject, isPotentialError } from '../error/error_inspector.ts';

export interface MetaCollectionState {
  foundError?: unknown;
  readonly additionalErrors: unknown[];
  readonly mergedMeta: Record<string, unknown>;
  readonly extraMeta: unknown[];
}

export function createMetaState(initialErr?: unknown): MetaCollectionState {
  return { foundError: initialErr, additionalErrors: [], mergedMeta: {}, extraMeta: [] };
}

function isPlainObject(item: unknown): item is Record<string, unknown> {
  return typeof item === 'object' && item !== null && !Array.isArray(item);
}

function mergeObjectMeta(itemObj: Record<string, unknown>, merged: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(itemObj)) {
    if (k === 'message') {
      merged['metaMessage'] = v;
    } else {
      merged[k] = v;
    }
  }
}

function appendErrorMeta(item: unknown, state: MetaCollectionState): void {
  if (!state.foundError) {
    state.foundError = item;
  } else {
    state.additionalErrors.push(item);
  }
}

function isErrorLike(item: unknown): boolean {
  return item instanceof Error || isErrorObject(item);
}

export function collectMetaItem(item: unknown, state: MetaCollectionState): void {
  if (isErrorLike(item)) {
    appendErrorMeta(item, state);
  } else if (isPlainObject(item)) {
    mergeObjectMeta(item, state.mergedMeta);
  } else {
    state.extraMeta.push(item);
  }
}

function checkPotentialError(val: unknown): unknown {
  return val !== undefined && isPotentialError(val) ? val : undefined;
}

function resolveFallbackError(merged: Record<string, unknown>): unknown {
  return checkPotentialError(merged['error']) ?? checkPotentialError(merged['err']);
}

function shouldPreserveContext(val: unknown, found: unknown): boolean {
  return val !== undefined && val !== found && !isErrorObject(val);
}

function assignErrorContext(merged: Record<string, unknown>, foundError: unknown): void {
  if (shouldPreserveContext(merged['error'], foundError)) {
    merged['errorContext'] = merged['error'];
  }
  if (shouldPreserveContext(merged['err'], foundError)) {
    merged['errorContext'] = merged['err'];
    delete merged['err'];
  }
  merged['error'] = foundError;
}

function resolveExtraMetaValue(extra: readonly unknown[]): unknown {
  return extra.length === 1 ? extra[0] : extra;
}

function attachExtras(state: MetaCollectionState): void {
  const merged = state.mergedMeta;
  if (state.additionalErrors.length > 0) merged['additionalErrors'] = state.additionalErrors;
  if (state.extraMeta.length > 0) merged['meta'] = resolveExtraMetaValue(state.extraMeta);
  delete merged['logType'];
}

export function finalizePayload(state: MetaCollectionState): Record<string, unknown> {
  attachExtras(state);
  const errorTarget = state.foundError ?? resolveFallbackError(state.mergedMeta);
  if (errorTarget !== undefined) assignErrorContext(state.mergedMeta, errorTarget);
  return state.mergedMeta;
}
