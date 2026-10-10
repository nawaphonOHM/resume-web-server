/**
 * URL path security check functions guarding against traversal, injection, and invalid path structures.
 *
 * @packageDocumentation
 */

import { extname } from 'node:path';
import { ALLOWED_STATIC_EXTENSIONS } from '../mime/mime_types.ts';

const DOT_DOT_REGEX = /\.\.|%2e%2e|%2e\.|\.%2e/i;
const ILLEGAL_DECODED_REGEX = /\0|\\|\.\./;
const ROOT_ESCAPE_REGEX = /^(?:\/|\.\.)?\.\.(?:\/|$)/;

export function stripSchemeAndHost(raw: string): string {
  if (/^https?:\/\/[^/]+/i.test(raw)) {
    const stripped = raw.replace(/^https?:\/\/[^/]+/i, '');
    return stripped === '' ? '/' : stripped;
  }
  return raw;
}

function checkNullBytes(raw: string): string | undefined {
  if (raw.includes('\0') || /%00/i.test(raw)) return 'Null byte injection detected';
  return undefined;
}

function checkSeparators(raw: string): string | undefined {
  if (raw.includes('\\')) return 'Backslash path separators not allowed';
  if (/%(?:2f|5c)/i.test(raw)) return 'Encoded path separators not allowed';
  return undefined;
}

function checkDoubleEncoding(raw: string): string | undefined {
  if (/%25(?:2e|2f|5c|00)/i.test(raw)) return 'Double-encoded characters detected';
  return undefined;
}

function checkDotDots(raw: string): string | undefined {
  if (DOT_DOT_REGEX.test(raw)) return 'Directory traversal sequence detected';
  return undefined;
}

function checkPreTraversal(raw: string): string | undefined {
  return checkNullBytes(raw) ?? checkSeparators(raw);
}

function checkPostTraversal(raw: string): string | undefined {
  return checkDoubleEncoding(raw) ?? checkDotDots(raw);
}

export function checkRawPathSecurity(rawPath: string): string | undefined {
  return checkPreTraversal(rawPath) ?? checkPostTraversal(rawPath);
}

export function checkDecodedPath(decoded: string): string | undefined {
  if (ILLEGAL_DECODED_REGEX.test(decoded)) return 'Invalid characters in decoded path';
  return undefined;
}

export function checkRootEscape(normalized: string): string | undefined {
  if (ROOT_ESCAPE_REGEX.test(normalized)) return 'Path escapes root directory';
  return undefined;
}

export function isAllowedExtension(ext: string): boolean {
  return ALLOWED_STATIC_EXTENSIONS.has(ext.toLowerCase());
}

const EXTENSION_PATTERN = /^\.[a-z0-9_.-]+$/i;

function isTargetExtension(ext: string): boolean {
  return ext !== '' && EXTENSION_PATTERN.test(ext);
}

/**
 * Validates file extensions for asset requests against allowed static types (`MIME_TYPES`).
 *
 * @remarks
 * Rejects requests with unsupported extensions (e.g. `.exe`, `.php`, `.env`, `.tar.gz`)
 * across both single-level and nested paths.
 */
export function checkAllowedExtension(normalized: string): string | undefined {
  const ext = extname(normalized).toLowerCase();
  if (isTargetExtension(ext) && !isAllowedExtension(ext)) {
    return `Disallowed file extension '${ext}'`;
  }
  return undefined;
}

export function checkNormalizedSecurity(normalized: string): string | undefined {
  return checkRootEscape(normalized) ?? checkAllowedExtension(normalized);
}
