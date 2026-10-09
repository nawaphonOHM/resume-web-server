/**
 * Bucket file listing and direct path computation under configured storage prefixes.
 *
 * @packageDocumentation
 */

import type { Bucket, File, GetFilesOptions } from '@google-cloud/storage';

function hasPrefix(name: string, pfx: string): boolean {
  return name.startsWith(`${pfx}/`) || name === pfx;
}

/**
 * Computes the direct lookup key for a relative asset path and prefix.
 *
 * @param cleanName - Clean relative asset name.
 * @param prefix - Bucket prefix.
 * @returns Fully qualified direct storage key.
 */
export function computeDirectPath(cleanName: string, prefix: string): string {
  const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!cleanPrefix || hasPrefix(cleanName, cleanPrefix)) return cleanName;
  return `${cleanPrefix}/${cleanName}`;
}

/**
 * Formats a prefix string into a trailing-slash GCS search prefix.
 *
 * @param prefix - Configured bucket prefix.
 * @returns Formatted search prefix.
 */
export function formatSearchPrefix(prefix: string): string {
  const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return cleanPrefix ? `${cleanPrefix}/` : '';
}

async function fetchFilePage(
  bucket: Bucket,
  query: GetFilesOptions,
): Promise<[File[], GetFilesOptions | null]> {
  const [pageFiles, nextQuery] = await bucket.getFiles(query);
  const next = (nextQuery as GetFilesOptions | null | undefined) ?? null;
  return [Array.isArray(pageFiles) ? pageFiles : [], next];
}

async function drainPages(bucket: Bucket, startQuery: GetFilesOptions): Promise<File[]> {
  const files: File[] = [];
  let query: GetFilesOptions | null = startQuery;
  while (query) {
    const [pageFiles, next] = await fetchFilePage(bucket, query);
    files.push(...pageFiles);
    query = next;
  }
  return files;
}

function makeStartQuery(searchPrefix: string): GetFilesOptions {
  return searchPrefix ? { prefix: searchPrefix, autoPaginate: false } : { autoPaginate: false };
}

/**
 * Lists all objects in a bucket under a search prefix, following pagination until complete.
 *
 * @param bucket - GCS Bucket instance.
 * @param prefix - Formatted prefix string.
 * @returns List of all discovered GCS File handles.
 */
export async function collectFilesUnderPrefix(bucket: Bucket, prefix: string): Promise<File[]> {
  return drainPages(bucket, makeStartQuery(prefix));
}
