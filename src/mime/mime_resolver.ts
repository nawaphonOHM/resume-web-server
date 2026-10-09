/**
 * Default MIME type resolver implementation.
 *
 * @packageDocumentation
 */

import { extname } from 'node:path';
import type { AppLogger } from '../logger/logger.ts';
import { type IMimeTypeResolver, MIME_TYPES, DEFAULT_MIME_TYPE } from './mime_types.ts';

function getMimeReason(ext: string, defaultMime: string, isKnown: boolean): string {
  if (isKnown) {
    return `Extension '${ext}' mapped from known MIME table`;
  }
  return `Extension '${ext}' unrecognized or absent, falling back to '${defaultMime}'`;
}

function makeMimePayload(filePath: string, ext: string, mime: string, reason: string) {
  const meta = { filePath, extension: ext, mimeType: mime };
  return {
    action: 'MimeResolver' as const,
    choice: `MIME type '${mime}'`,
    reason,
    level: 'debug' as const,
    ...meta,
  };
}

/**
 * Default implementation of {@link IMimeTypeResolver} backed by standard MIME type definitions.
 */
export class DefaultMimeTypeResolver implements IMimeTypeResolver {
  /**
   * Lookup table mapping file extensions to MIME types.
   */
  private readonly mimeTypes: Readonly<Record<string, string | undefined>>;

  /**
   * Default fallback MIME type.
   */
  private readonly defaultMimeType: string;

  /**
   * Optional injected application logger for recording resolution decisions.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `DefaultMimeTypeResolver`.
   *
   * @param mimeTypes - Optional custom extension-to-MIME lookup map. Defaults to {@link MIME_TYPES}.
   * @param defaultMimeType - Optional fallback MIME type string. Defaults to {@link DEFAULT_MIME_TYPE}.
   * @param logger - Optional injected application logger.
   */
  public constructor(
    mimeTypes: Readonly<Record<string, string | undefined>> = MIME_TYPES,
    defaultMimeType: string = DEFAULT_MIME_TYPE,
    logger?: AppLogger,
  ) {
    this.mimeTypes = mimeTypes;
    this.defaultMimeType = defaultMimeType;
    this.logger = logger;
  }

  private logResolution(filePath: string, ext: string, mime: string, isKnown: boolean): void {
    if (!this.logger) return;
    const reason = getMimeReason(ext, this.defaultMimeType, isKnown);
    this.logger.decision(makeMimePayload(filePath, ext, mime, reason));
  }

  /**
   * Resolves the MIME content-type string for a given file path based on its extension.
   *
   * @param filePath - The file path or filename to evaluate.
   * @returns The associated MIME content-type string with charset (if applicable), or fallback.
   */
  public getMimeType(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    const resolved = this.mimeTypes[ext];
    const mime = resolved ?? this.defaultMimeType;
    this.logResolution(filePath, ext, mime, Boolean(resolved));
    return mime;
  }
}
