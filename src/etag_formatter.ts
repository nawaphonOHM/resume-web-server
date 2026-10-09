/**
 * RFC 9110 compliant HTTP ETag formatting and weak validator conversion.
 *
 * @packageDocumentation
 */

import type { IEtagFormatter } from './storage/storage_types.ts';

const WEAK_PREFIX_LENGTH = 2;

function stripWeakPrefix(rawTag: string): { tag: string; isWeak: boolean } {
  if (rawTag.startsWith('W/')) {
    return { tag: rawTag.slice(WEAK_PREFIX_LENGTH).trim(), isWeak: true };
  }
  return { tag: rawTag, isWeak: false };
}

function quoteTag(tag: string): string {
  const withLeading = tag.startsWith('"') ? tag : `"${tag}`;
  return withLeading.endsWith('"') ? withLeading : `${withLeading}"`;
}

function buildFormattedEtag(quotedTag: string, isWeak: boolean, isGzip: boolean): string {
  if (isGzip || isWeak) {
    return `W/${quotedTag}`;
  }
  return quotedTag;
}

/**
 * RFC 9110 compliant ETag formatting implementation (Single Responsibility Principle).
 */
export class RFC9110EtagFormatter implements IEtagFormatter {
  /**
   * Formats and normalizes an ETag string according to RFC 9110 HTTP semantics.
   *
   * @param rawEtag - Raw ETag string provided by storage metadata.
   * @param isGzip - Whether the object payload is gzipped and auto-decompressed.
   * @returns A formatted ETag string (quoted, optionally weak-prefixed), or an empty string if blank.
   */
  public formatEtag(rawEtag: string, isGzip: boolean): string {
    const trimmed = rawEtag.trim();
    if (trimmed === '') {
      return '';
    }
    const { tag, isWeak } = stripWeakPrefix(trimmed);
    const quoted = quoteTag(tag);
    return buildFormattedEtag(quoted, isWeak, isGzip);
  }
}

/**
 * Default singleton helper instance.
 */
export const defaultEtagFormatter: IEtagFormatter = new RFC9110EtagFormatter();

/**
 * Formats and normalizes an ETag string according to RFC 9110 HTTP semantics.
 *
 * @remarks
 * RFC 9110 §8.8.3 requires entity-tag values to be enclosed in double quotes and
 * defines the `W/` prefix syntax for weak validators. When resources are stored
 * gzipped but auto-decompressed by GCS during streaming, the representation bytes
 * change, so per RFC 9110 §8.8.1 a strong validator can no longer be used and must
 * be downgraded to a weak entity-tag (`W/"..."`).
 *
 * @param rawEtag - Raw ETag string provided by storage metadata.
 * @param isGzip - Whether the object payload is gzipped and auto-decompressed.
 * @returns A formatted ETag string (quoted, optionally weak-prefixed), or an empty string if input is blank.
 *
 * @example
 * ```ts
 * formatEtag('12345', false);     // '"12345"'
 * formatEtag('"12345"', true);    // 'W/"12345"'
 * formatEtag('W/"12345"', false); // 'W/"12345"'
 * formatEtag('', false);          // ''
 * ```
 */
export function formatEtag(rawEtag: string, isGzip: boolean): string {
  return defaultEtagFormatter.formatEtag(rawEtag, isGzip);
}
