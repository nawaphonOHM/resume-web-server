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

export {
  MIME_TYPES,
  DEFAULT_MIME_TYPE,
  CACHE_CONTROL_IMMUTABLE,
  CACHE_CONTROL_NO_CACHE,
  HASHED_ASSET_REGEX,
  KNOWN_HTML_EXTENSIONS,
  KNOWN_STATIC_EXTENSIONS,
  ALLOWED_STATIC_EXTENSIONS,
  type IMimeTypeResolver,
  type IAssetClassifier,
  type ICachePolicyResolver,
} from './mime_types.ts';

export { DefaultMimeTypeResolver } from './mime_resolver.ts';
export { DefaultAssetClassifier } from '../asset_classifier.ts';
export { DefaultCachePolicyResolver } from '../cache_policy.ts';

import type { IMimeTypeResolver, IAssetClassifier, ICachePolicyResolver } from './mime_types.ts';
import { DefaultMimeTypeResolver } from './mime_resolver.ts';
import { DefaultAssetClassifier } from '../asset_classifier.ts';
import { DefaultCachePolicyResolver } from '../cache_policy.ts';

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
