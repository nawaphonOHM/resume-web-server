/**
 * MIME Type Resolution and HTTP Caching Utilities.
 *
 * Provides MIME content-type mapping, static asset classification, Angular / esbuild
 * bundle fingerprint detection, and HTTP `Cache-Control` header generation for Single Page Applications (SPA)
 * following SOLID principles.
 *
 * @remarks
 * In an SPA architecture, static assets (JS chunks, CSS stylesheets, fonts, images) with content-hashed
 * filenames can be aggressively cached with immutable directives. Conversely, HTML entry points,
 * service worker manifests, and unhashed assets must be revalidated on every request to guarantee
 * immediate propagation of new deployments.
 *
 * @packageDocumentation
 */

import { extname } from 'node:path';
import type { AppLogger } from './logger.ts';

/**
 * Immutable lookup map associating lowercase file extensions to their corresponding
 * standard MIME content-type and character encoding strings.
 */
export const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.manifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
});

/**
 * Fallback MIME type returned when a file extension is not recognized or absent.
 */
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Cache-Control header directive for immutable, content-hashed static assets.
 *
 * @remarks
 * Instructs browsers and intermediary CDNs to cache the asset for up to 1 year (31,536,000 seconds)
 * without revalidation, as the content hash guarantees uniqueness across builds.
 */
export const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Cache-Control header directive for mutable resources (e.g. `index.html`, unhashed icons, service worker configs).
 *
 * @remarks
 * Instructs caches that the response may be cached, but must be revalidated with the origin server
 * via conditional requests (e.g., `If-None-Match` with ETags) before use.
 */
export const CACHE_CONTROL_NO_CACHE = 'public, max-age=0, must-revalidate';

/**
 * Regular expression matching Angular CLI / esbuild content-hashed asset filenames.
 *
 * @remarks
 * Angular and esbuild output fingerprinted asset bundles with a format such as:
 * - `main-5T7P2N6K.js`
 * - `chunk-b-4s_SpF.js`
 * - `styles-5INURTSO.css`
 * - `media/font-6G54T7R3.woff2`
 * - `main-5T7P2N6K.js.map`
 *
 * The pattern matches an 8-character hash segment following a hyphen (`-`), containing
 * alphanumeric, underscore, or hyphen characters (`[A-Za-z0-9_-]{8}`), requiring at least one
 * digit or uppercase letter (`(?=[^.]*[0-9A-Z])`), positioned immediately prior to a supported
 * web asset extension (with an optional trailing `.map` source map extension).
 */
export const HASHED_ASSET_REGEX =
  /-(?=[A-Za-z0-9_-]{8}\.(?:[a-z0-9]+\.)?[a-z0-9]+$)(?=[^.]*[0-9A-Z])[A-Za-z0-9_-]{8}\.(?:js|mjs|cjs|css|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|webp|avif|ico|wasm)(?:\.map)?$/;

/**
 * Contract for resolving MIME types from file paths (Interface Segregation Principle).
 */
export interface IMimeTypeResolver {
  /**
   * Resolves the MIME content-type string for a given file path based on its extension.
   *
   * @param filePath - The file path or filename to evaluate.
   * @returns The associated MIME content-type string.
   */
  getMimeType(filePath: string): string;
}

/**
 * Contract for classifying web assets and determining fingerprinting (Interface Segregation Principle).
 */
export interface IAssetClassifier {
  /**
   * Determines whether a request path targets a static asset file rather than an HTML document or SPA navigation route.
   *
   * @param filePath - The cleaned relative request path or filename.
   * @returns `true` if the path has a non-HTML file extension, `false` otherwise.
   */
  isStaticAsset(filePath: string): boolean;

  /**
   * Evaluates whether a static asset file is content-hashed (fingerprinted) and safe for long-term immutable caching.
   *
   * @param filePath - The file path or filename to inspect.
   * @returns `true` if the asset is fingerprinted and safe for immutable caching; `false` otherwise.
   */
  isHashedAsset(filePath: string): boolean;
}

/**
 * Contract for resolving HTTP cache control header policies (Interface Segregation Principle).
 */
export interface ICachePolicyResolver {
  /**
   * Computes the appropriate HTTP `Cache-Control` header value for a given file path.
   *
   * @param filePath - The file path or filename to determine cache policy for.
   * @param isHashed - Optional precomputed boolean indicating if the asset is hashed.
   * @returns The HTTP `Cache-Control` header string directive.
   */
  getCacheControlHeader(filePath: string, isHashed?: boolean): string;
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

    if (this.logger) {
      this.logger.decision({
        action: 'MimeResolver',
        choice: `MIME type '${mime}'`,
        reason: resolved
          ? `Extension '${ext}' mapped from known MIME table`
          : `Extension '${ext}' unrecognized or absent, falling back to '${this.defaultMimeType}'`,
        level: 'debug',
        filePath,
        extension: ext,
        mimeType: mime,
      });
    }

    return mime;
  }
}

/**
 * Default implementation of {@link IAssetClassifier} for Angular / SPA assets.
 */
export class DefaultAssetClassifier implements IAssetClassifier {
  /**
   * Optional injected application logger for recording classification decisions.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `DefaultAssetClassifier`.
   *
   * @param logger - Optional injected application logger.
   */
  public constructor(logger?: AppLogger) {
    this.logger = logger;
  }

  /**
   * Determines whether a request path targets a static asset file rather than an HTML document or SPA navigation route.
   *
   * @param filePath - The cleaned relative request path or filename.
   * @returns `true` if the path has a non-HTML file extension, `false` otherwise.
   */
  public isStaticAsset(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    const isStatic = ext !== '' && ext !== '.html' && ext !== '.htm';

    if (this.logger) {
      this.logger.decision({
        action: 'AssetClassifier',
        choice: isStatic ? 'static asset' : 'SPA navigation route / HTML',
        reason: isStatic
          ? `Path has non-HTML extension '${ext}'`
          : ext === ''
            ? 'Path is extensionless'
            : `Path has HTML extension '${ext}'`,
        level: 'debug',
        filePath,
        extension: ext,
      });
    }

    return isStatic;
  }

  /**
   * Evaluates whether a static asset file is content-hashed (fingerprinted) and safe for long-term immutable caching.
   *
   * @param filePath - The file path or filename to inspect.
   * @returns `true` if the asset is fingerprinted and safe for immutable caching; `false` otherwise.
   */
  public isHashedAsset(filePath: string): boolean {
    const baseName = filePath.split(/[/\\]/).pop() ?? filePath;
    if (
      baseName.startsWith('index.') ||
      baseName.startsWith('ngsw') ||
      baseName.startsWith('favicon') ||
      baseName.startsWith('manifest') ||
      baseName.startsWith('browserconfig')
    ) {
      if (this.logger) {
        this.logger.decision({
          action: 'AssetClassifier',
          choice: 'mutable asset (unhashed)',
          reason: `Asset '${baseName}' is a well-known mutable/root configuration file`,
          level: 'debug',
          filePath,
          baseName,
          isHashed: false,
        });
      }
      return false;
    }

    const matched = HASHED_ASSET_REGEX.test(baseName);
    if (this.logger) {
      this.logger.decision({
        action: 'AssetClassifier',
        choice: matched ? 'content-hashed asset' : 'unhashed asset',
        reason: matched
          ? `Asset '${baseName}' matched content-hash regex pattern`
          : `Asset '${baseName}' does not match content-hash regex pattern`,
        level: 'debug',
        filePath,
        baseName,
        isHashed: matched,
      });
    }

    return matched;
  }
}

/**
 * Default implementation of {@link ICachePolicyResolver} applying immutable or revalidation caching policies.
 */
export class DefaultCachePolicyResolver implements ICachePolicyResolver {
  /**
   * The asset classifier used to check whether assets are content-hashed.
   */
  private readonly assetClassifier: IAssetClassifier;

  /**
   * Optional injected application logger for recording cache policy decisions.
   */
  private readonly logger?: AppLogger;

  /**
   * Creates a new `DefaultCachePolicyResolver`.
   *
   * @param assetClassifier - Injected asset classifier instance. Defaults to {@link DefaultAssetClassifier}.
   * @param logger - Optional injected application logger.
   */
  public constructor(
    assetClassifier: IAssetClassifier = new DefaultAssetClassifier(),
    logger?: AppLogger,
  ) {
    this.assetClassifier = assetClassifier;
    this.logger = logger;
  }

  /**
   * Computes the appropriate HTTP `Cache-Control` header value for a given file path.
   *
   * @param filePath - The file path or filename to determine cache policy for.
   * @param isHashed - Optional precomputed boolean indicating if the asset is hashed.
   * @returns The HTTP `Cache-Control` header string directive.
   */
  public getCacheControlHeader(filePath: string, isHashed?: boolean): string {
    const hashed = isHashed ?? this.assetClassifier.isHashedAsset(filePath);
    const header = hashed ? CACHE_CONTROL_IMMUTABLE : CACHE_CONTROL_NO_CACHE;

    if (this.logger) {
      this.logger.decision({
        action: 'CachePolicy',
        choice: hashed ? 'immutable (31536000s)' : 'no-cache (must-revalidate)',
        reason: hashed
          ? `Asset '${filePath}' matched content-hashed filename pattern`
          : `Asset '${filePath}' is unhashed or mutable and requires origin revalidation`,
        level: 'debug',
        filePath,
        isHashed: hashed,
        cacheControl: header,
      });
    }

    return header;
  }
}

/**
 * Default singleton resolver instances.
 */
const defaultMimeTypeResolver: IMimeTypeResolver = new DefaultMimeTypeResolver();
const defaultAssetClassifier: IAssetClassifier = new DefaultAssetClassifier();
const defaultCachePolicyResolver: ICachePolicyResolver = new DefaultCachePolicyResolver(
  defaultAssetClassifier,
);

/**
 * Resolves the MIME content-type string for a given file path based on its extension.
 *
 * @remarks
 * Extracts the file extension, converts it to lowercase, and looks it up in {@link MIME_TYPES}.
 * If the extension is missing or not present in the lookup table, returns {@link DEFAULT_MIME_TYPE}.
 *
 * @param filePath - The file path or filename to evaluate.
 * @returns The associated MIME content-type string with charset (if applicable), or {@link DEFAULT_MIME_TYPE}.
 *
 * @example
 * ```ts
 * getMimeType('styles.css'); // 'text/css; charset=utf-8'
 * getMimeType('IMAGE.PNG');   // 'image/png'
 * getMimeType('unknown.xyz'); // 'application/octet-stream'
 * ```
 */
export function getMimeType(filePath: string): string {
  return defaultMimeTypeResolver.getMimeType(filePath);
}

/**
 * Determines whether a request path targets a static asset file rather than an HTML document or SPA navigation route.
 *
 * @remarks
 * Identifies static assets by checking for the presence of a file extension that is not `.html` or `.htm`.
 * Extensionless paths (e.g. `/profile`, `/settings`) and HTML files are classified as non-static
 * and should be handled by the SPA fallback mechanism (serving `index.html`).
 *
 * @param filePath - The cleaned relative request path or filename.
 * @returns `true` if the path has a non-HTML file extension, `false` otherwise.
 *
 * @example
 * ```ts
 * isStaticAsset('/main.js');      // true
 * isStaticAsset('/favicon.ico');  // true
 * isStaticAsset('/profile');      // false
 * isStaticAsset('/index.html');   // false
 * ```
 */
export function isStaticAsset(filePath: string): boolean {
  return defaultAssetClassifier.isStaticAsset(filePath);
}

/**
 * Evaluates whether a static asset file is content-hashed (fingerprinted) and safe for long-term immutable caching.
 *
 * @remarks
 * Evaluates the basename of the given path against {@link HASHED_ASSET_REGEX}.
 * Explicitly excludes mutable and well-known root configuration files regardless of regex matching:
 * - `index.*` (HTML entrypoints)
 * - `ngsw*` (Angular Service Worker scripts and manifests, e.g. `ngsw.json`, `ngsw-worker.js`)
 * - `favicon*` (Favicons and icons)
 * - `manifest*` (Web app manifests)
 * - `browserconfig*` (IE/Edge tile configurations)
 *
 * @param filePath - The file path or filename to inspect.
 * @returns `true` if the asset is fingerprinted and safe for immutable caching; `false` otherwise.
 *
 * @example
 * ```ts
 * isHashedAsset('main-5T7P2N6K.js'); // true
 * isHashedAsset('styles-5INURTSO.css'); // true
 * isHashedAsset('main.js'); // false
 * isHashedAsset('favicon.ico'); // false
 * isHashedAsset('index.html'); // false
 * ```
 */
export function isHashedAsset(filePath: string): boolean {
  return defaultAssetClassifier.isHashedAsset(filePath);
}

/**
 * Computes the appropriate HTTP `Cache-Control` header value for a given file path.
 *
 * @remarks
 * If `isHashed` is explicitly provided as a boolean, it is used directly; otherwise,
 * {@link isHashedAsset} is called on `filePath`.
 * Hashed assets receive {@link CACHE_CONTROL_IMMUTABLE}, while unhashed assets and HTML files
 * receive {@link CACHE_CONTROL_NO_CACHE}.
 *
 * @param filePath - The file path or filename to determine cache policy for.
 * @param isHashed - Optional precomputed boolean indicating if the asset is hashed.
 * @returns The HTTP `Cache-Control` header string directive.
 *
 * @example
 * ```ts
 * getCacheControlHeader('main-5T7P2N6K.js'); // 'public, max-age=31536000, immutable'
 * getCacheControlHeader('index.html');        // 'public, max-age=0, must-revalidate'
 * getCacheControlHeader('custom.js', true);   // 'public, max-age=31536000, immutable'
 * ```
 */
export function getCacheControlHeader(filePath: string, isHashed?: boolean): string {
  return defaultCachePolicyResolver.getCacheControlHeader(filePath, isHashed);
}
