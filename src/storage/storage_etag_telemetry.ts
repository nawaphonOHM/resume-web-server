/**
 * Structured decision logging helpers for ETag handling.
 *
 * @packageDocumentation
 */

import type { AppLogger, DecisionLogPayload } from '../logger/logger_types.ts';

export interface EtagDecisionInput {
  readonly rawEtag?: string;
  readonly formattedEtag: string;
  readonly contentEncoding?: string;
  readonly isGzip: boolean;
  readonly fullPath: string;
}

const GZIP_REASON =
  'GCS object has gzip Content-Encoding and will be auto-decompressed on the fly (RFC 9110)';

const STRONG_REASON =
  'GCS object is not auto-decompressed by SDK (passthrough), preserving strong validator and Content-Length (RFC 9110)';

function gzipChoice(formattedEtag: string): string {
  if (formattedEtag !== '') return `Weak ETag (${formattedEtag})`;
  return 'Omit Content-Length and Content-Encoding';
}

function gzipFormatted(formattedEtag: string): string | undefined {
  return formattedEtag === '' ? undefined : formattedEtag;
}

function makeGzipCore(formattedEtag: string): DecisionLogPayload {
  return {
    action: 'StorageEtag',
    choice: gzipChoice(formattedEtag),
    reason: GZIP_REASON,
    level: 'debug',
  };
}

function gzipMeta(input: EtagDecisionInput): Record<string, unknown> {
  return {
    rawEtag: input.rawEtag,
    formattedEtag: gzipFormatted(input.formattedEtag),
    contentEncoding: input.contentEncoding,
    isGzip: true,
    path: input.fullPath,
    omittedHeaders: 'Content-Length, Content-Encoding',
  };
}

function makeGzipPayload(input: EtagDecisionInput): DecisionLogPayload {
  return Object.assign(makeGzipCore(input.formattedEtag), gzipMeta(input));
}

function makeStrongCore(formattedEtag: string): DecisionLogPayload {
  return {
    action: 'StorageEtag',
    choice: `Strong ETag (${formattedEtag})`,
    reason: STRONG_REASON,
    level: 'debug',
  };
}

function strongMeta(input: EtagDecisionInput): Record<string, unknown> {
  return {
    rawEtag: input.rawEtag,
    formattedEtag: input.formattedEtag,
    contentEncoding: input.contentEncoding,
    isGzip: false,
    path: input.fullPath,
  };
}

function makeStrongPayload(input: EtagDecisionInput): DecisionLogPayload {
  return Object.assign(makeStrongCore(input.formattedEtag), strongMeta(input));
}

export function logStorageEtagDecision(appLogger: AppLogger, input: EtagDecisionInput): void {
  if (input.isGzip) {
    appLogger.decision(makeGzipPayload(input));
    return;
  }
  if (input.formattedEtag !== '') {
    appLogger.decision(makeStrongPayload(input));
  }
}
