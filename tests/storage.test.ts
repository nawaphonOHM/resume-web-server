import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import type { Storage, Bucket, File } from '@google-cloud/storage';
import {
  GcsStorageService,
  createStorageService,
  isNotFoundError,
  formatEtag,
  StoragePathResolver,
  RFC9110EtagFormatter,
  GcsErrorClassifier,
  StorageObjectLocator,
  parseTimestampFromDirectory,
  computeDirectPath,
  extractCandidateMatch,
  compareCandidates,
  resolveStorageDeps,
  type StorageServiceOptions,
  type IStorageObjectLocator,
  type CandidateFileMatch,
} from '../src/storage/storage.ts';
import type { ServerConfig } from '../src/config/config.ts';
import { createAppLogger, type AppLogger, type DecisionLogPayload } from '../src/logger/logger.ts';
import winston from 'winston';

const silentLogger = createAppLogger({ silent: true });

/**
 * Custom memory writable stream to capture formatted log output in storage tests.
 */
class MemoryLogStream extends Writable {
  readonly lines: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.lines.push(chunk.toString());
    callback();
  }

  get output(): string {
    return this.lines.join('');
  }

  clear(): void {
    this.lines.length = 0;
  }
}

interface CapturedLog {
  level: string;
  message: string | Error;
  meta: unknown[];
}

/**
 * Creates a mock {@link AppLogger} that captures emitted decisions and log messages.
 */
function createCapturingLogger(): {
  logger: AppLogger;
  decisions: DecisionLogPayload[];
  logs: CapturedLog[];
} {
  const decisions: DecisionLogPayload[] = [];
  const logs: CapturedLog[] = [];

  const capturingLogger: AppLogger = {
    info: (msg, ...meta) => logs.push({ level: 'info', message: msg, meta }),
    warn: (msg, ...meta) => logs.push({ level: 'warn', message: msg, meta }),
    error: (msg, ...meta) => logs.push({ level: 'error', message: msg, meta }),
    http: (msg, ...meta) => logs.push({ level: 'http', message: msg, meta }),
    debug: (msg, ...meta) => logs.push({ level: 'debug', message: msg, meta }),
    decision: (payload: DecisionLogPayload) => {
      decisions.push(payload);
    },
  };

  return { logger: capturingLogger, decisions, logs };
}

/**
 * Options for configuring a simulated Google Cloud Storage {@link File} object in unit tests.
 */
interface MockFileOptions {
  /**
   * String content payload to return when the file's read stream is consumed.
   *
   * @defaultValue `'sample file content'`
   */
  content?: string;

  /**
   * Whether the file is reported as existing when {@link File.exists} is invoked.
   *
   * @defaultValue `true`
   */
  exists?: boolean;

  /**
   * Metadata properties returned by {@link File.getMetadata}.
   *
   * @defaultValue `{ size: 100, etag: '"etag-123"' }`
   */
  metadata?: { size?: number; etag?: string; contentEncoding?: string };

  /**
   * Error to immediately emit from the read stream upon read initiation.
   */
  errorOnStream?: Error;

  /**
   * Error to reject with when {@link File.getMetadata} is invoked.
   */
  errorOnMetadata?: Error;

  /**
   * Simulated GCS HTTP response event payload emitted by the read stream prior to chunk delivery.
   */
  emitResponseEvent?: { statusCode: number; headers?: Record<string, string> };

  /**
   * Error to emit on the read stream after emitting the simulated `response` event but before payload streaming.
   *
   * @remarks
   * Only takes effect when {@link MockFileOptions.emitResponseEvent} is also set; otherwise the
   * stream stalls without emitting the error. While set, no payload data is pushed.
   */
  errorAfterResponse?: Error;

  /**
   * Error to emit on the read stream after an initial data chunk has already been pushed to the client.
   */
  errorAfterData?: Error;

  /**
   * Callback invoked when the read stream is destroyed via {@link Readable.destroy}.
   */
  onStreamDestroyed?: () => void;
}

/**
 * Factory function creating a mocked `@google-cloud/storage` {@link File} instance.
 *
 * @param options - Configuration options for mocked metadata, existence status, stream content, and error events.
 * @param name - Object name for the mocked file.
 * @returns A mocked {@link File} instance satisfying GCS read and metadata operations.
 */
function createMockFile(options: MockFileOptions, name = 'test-file'): File {
  return {
    name,
    exists: () => Promise.resolve([options.exists ?? true]),
    getMetadata: () => {
      if (options.errorOnMetadata) {
        return Promise.reject(options.errorOnMetadata);
      }
      return Promise.resolve([
        options.metadata ?? { size: 100, etag: '"etag-123"', contentEncoding: undefined },
      ]);
    },
    createReadStream: () => {
      if (options.errorOnStream) {
        const stream = new Readable({
          read() {
            process.nextTick(() => {
              this.emit('error', options.errorOnStream);
            });
          },
          destroy(err, cb) {
            options.onStreamDestroyed?.();
            cb(err);
          },
        });
        return stream;
      }

      const stream = new Readable({
        read() {
          if (options.errorAfterResponse) {
            return;
          }
          if (options.errorAfterData) {
            this.push(Buffer.from('partial-data'));
            process.nextTick(() => {
              this.emit('error', options.errorAfterData);
            });
            return;
          }
          const content = options.content ?? 'sample file content';
          this.push(Buffer.from(content));
          this.push(null);
        },
        destroy(err, cb) {
          options.onStreamDestroyed?.();
          cb(err);
        },
      });

      if (options.emitResponseEvent) {
        process.nextTick(() => {
          stream.emit('response', options.emitResponseEvent);
          if (options.errorAfterResponse) {
            process.nextTick(() => {
              stream.emit('error', options.errorAfterResponse);
            });
          }
        });
      }

      return stream;
    },
  } as unknown as File;
}

/**
 * Factory function creating a mocked `@google-cloud/storage` {@link Storage} client.
 *
 * @param fileMap - Mapping of object names to their respective {@link MockFileOptions} configurations.
 * @returns A mocked {@link Storage} instance routing bucket and file lookups to simulated file objects.
 */
function createMockStorage(fileMap: Map<string, MockFileOptions>): Storage {
  const mockBucket: Bucket = {
    file: (name: string) => {
      const opts = fileMap.get(name) ?? {
        errorOnStream: Object.assign(new Error(`No such object: ${name}`), { code: 404 }),
        errorOnMetadata: Object.assign(new Error(`No such object: ${name}`), { code: 404 }),
        exists: false,
      };
      return createMockFile(opts, name);
    },
    getFiles: (query?: { prefix?: string }) => {
      const pfx = query?.prefix ?? '';
      const matchedFiles: File[] = [];
      for (const [name, opts] of fileMap.entries()) {
        if (opts.exists === false) continue;
        if (!pfx || name.startsWith(pfx)) {
          matchedFiles.push(createMockFile(opts, name));
        }
      }
      return Promise.resolve([matchedFiles, null]);
    },
  } as unknown as Bucket;

  return {
    bucket: () => mockBucket,
  } as unknown as Storage;
}

/**
 * Default test server configuration fixture for storage service test suites.
 */
const testConfig: ServerConfig = {
  port: 8080,
  host: '0.0.0.0',
  bucketName: 'test-bucket',
  prefix: 'resume_cloudbuild/angular',
};

/**
 * Snapshot of an HTTP response captured during integration test execution.
 */
interface ResponseResult {
  /**
   * HTTP status code returned by the server.
   */
  statusCode: number;

  /**
   * Parsed HTTP response headers.
   */
  headers: http.IncomingHttpHeaders;

  /**
   * UTF-8 decoded HTTP response body string.
   */
  body: string;
}

/**
 * Issues an HTTP request to the running test server and collects the status, headers, and body.
 *
 * @param server - Active Node.js HTTP server instance.
 * @param path - URL path and query string to request.
 * @param method - HTTP request method (e.g. `'GET'`, `'HEAD'`). Defaults to `'GET'`.
 * @returns A promise resolving to the captured {@link ResponseResult}.
 */
function executeRequest(
  server: http.Server,
  path: string,
  method = 'GET',
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const address = server.address() as AddressInfo;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: Buffer | string) => {
          body += String(chunk);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
        res.on('error', reject);
        res.on('aborted', () => {
          reject(new Error('Response aborted by server'));
        });
        res.on('close', () => {
          if (!res.complete) {
            reject(new Error('Connection closed before response completed'));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Spawns an ephemeral Node.js HTTP server on loopback (`127.0.0.1`) bound to an OS-assigned dynamic port.
 *
 * @param service - Storage service instance provided to the handler callback.
 * @param handler - Custom HTTP request handler function under test.
 * @returns A promise resolving to an object containing the running server instance and an async teardown function.
 */
function startTestServer(
  service: GcsStorageService,
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    service: GcsStorageService,
  ) => void,
): Promise<{ server: http.Server; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handler(req, res, service);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        close: async () => {
          await new Promise<void>((resClose) => {
            server.close(() => {
              resClose();
            });
          });
        },
      });
    });
  });
}

/**
 * Integration and unit test suites for {@link GcsStorageService} and GCS error/ETag helpers.
 *
 * @remarks
 * Validates:
 * - Prefix resolution and object path canonicalization in {@link GcsStorageService.resolveObjectName}.
 * - File existence checks and missing bucket error discrimination in {@link GcsStorageService.fileExists}.
 * - Real HTTP GET streaming lifecycle, including RFC 9110 weak ETag conversion and Content-Length stripping for gzip assets.
 * - Real HTTP HEAD metadata responses, header parity with GET, and zero-body transport.
 * - Socket teardown, premature client abortion handling, and stale header clearing on mid-stream errors.
 * - Error categorization in {@link isNotFoundError} distinguishing 404 object errors from missing bucket errors (mapped to 502).
 * - RFC 9110 compliant quoting and weak-prefix formatting in {@link formatEtag}.
 */
void describe('GCS Storage Service', () => {
  /**
   * Tests for {@link GcsStorageService.resolveObjectName}.
   *
   * @remarks
   * Verifies bucket prefix prepending, idempotency when prefix is already present, and empty prefix handling.
   */
  void describe('resolveObjectName', () => {
    void it('should prepend prefix to relative paths', () => {
      const service = createStorageService(testConfig);
      assert.equal(service.resolveObjectName('main.js'), 'resume_cloudbuild/angular/main.js');
      assert.equal(
        service.resolveObjectName('/styles.css'),
        'resume_cloudbuild/angular/styles.css',
      );
    });

    void it('should not duplicate prefix if already present', () => {
      const service = createStorageService(testConfig);
      assert.equal(
        service.resolveObjectName('resume_cloudbuild/angular/main.js'),
        'resume_cloudbuild/angular/main.js',
      );
      assert.equal(
        service.resolveObjectName('/resume_cloudbuild/angular/main.js'),
        'resume_cloudbuild/angular/main.js',
      );
    });

    void it('should handle empty prefix configuration', () => {
      const service = createStorageService({
        ...testConfig,
        prefix: '',
      });
      assert.equal(service.resolveObjectName('main.js'), 'main.js');
      assert.equal(service.resolveObjectName('/main.js'), 'main.js');
    });
  });

  /**
   * Tests for {@link GcsStorageService.fileExists}.
   *
   * @remarks
   * Verifies bucket lookup resolution, 404 object discrimination, path strings containing "bucket",
   * and exception rethrowing when the GCS bucket itself is missing.
   */
  void describe('fileExists', () => {
    void it('should return true when file exists in bucket', async () => {
      const files = new Map<string, MockFileOptions>([
        ['resume_cloudbuild/angular/index.html', { exists: true }],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));

      const exists = await service.fileExists('index.html');
      assert.equal(exists, true);
    });

    void it('should return false when file does not exist in bucket (404)', async () => {
      const files = new Map<string, MockFileOptions>();
      const service = new GcsStorageService(testConfig, createMockStorage(files));

      const exists = await service.fileExists('non-existent.js');
      assert.equal(exists, false);
    });

    void it('should return false when missing file has "bucket" in bucket name or object path', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/assets/bucket/missing.js',
          {
            exists: false,
            errorOnMetadata: Object.assign(
              new Error(
                'No such object: test-bucket/resume_cloudbuild/angular/assets/bucket/missing.js',
              ),
              { code: 404 },
            ),
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));

      const exists = await service.fileExists('assets/bucket/missing.js');
      assert.equal(exists, false);
    });

    void it('should throw error when GCS encounters 500 error or bucket is missing', async () => {
      const customFile = {
        exists: () =>
          Promise.reject(
            Object.assign(new Error('The specified bucket does not exist.'), { code: 404 }),
          ),
      } as unknown as File;
      const customStorage = {
        bucket: () => ({ file: () => customFile }),
      } as unknown as Storage;
      const service = new GcsStorageService(
        testConfig,
        customStorage,
        undefined,
        undefined,
        undefined,
        silentLogger,
      );

      await assert.rejects(
        async () => {
          await service.fileExists('index.html');
        },
        { message: 'The specified bucket does not exist.' },
      );
    });
  });

  /**
   * End-to-end integration tests for {@link GcsStorageService.streamFile} processing GET requests over real sockets.
   *
   * @remarks
   * Covers uncompressed transfers, gzip transparent auto-decompression framing, brotli passthrough,
   * GCS connection failures, mid-stream socket destruction, client disconnect propagation, and custom fallback status codes.
   */
  void describe('Real node:http integration - GET requests', () => {
    void it('should stream uncompressed file with 200 OK, Content-Length, and ETag', async () => {
      const content = 'console.log("uncompressed bundle");';
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/main-5T7P2N6K.js',
          {
            content,
            emitResponseEvent: {
              statusCode: 200,
              headers: {
                'content-length': String(Buffer.byteLength(content)),
                etag: '"hash-abc"',
              },
            },
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile(
          'main-5T7P2N6K.js',
          res,
          'application/javascript; charset=utf-8',
          true,
          false,
        );
      });

      try {
        const response = await executeRequest(testEnv.server, '/main-5T7P2N6K.js');
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'application/javascript; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal(response.headers['content-length'], String(Buffer.byteLength(content)));
        assert.equal(response.headers.etag, '"hash-abc"');
        assert.equal(response.body, content);
      } finally {
        await testEnv.close();
      }
    });

    void it('should stream gzip-stored file without setting compressed Content-Length and use weak ETag', async () => {
      const decompressedContent = 'A'.repeat(1350);
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/main-5T7P2N6K.js',
          {
            content: decompressedContent,
            emitResponseEvent: {
              statusCode: 200,
              headers: {
                'content-encoding': 'gzip',
                'content-length': '60',
                etag: 'CKih16GjycICEAE=',
              },
            },
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile(
          'main-5T7P2N6K.js',
          res,
          'application/javascript; charset=utf-8',
          true,
          false,
        );
      });

      try {
        const response = await executeRequest(testEnv.server, '/main-5T7P2N6K.js');
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'application/javascript; charset=utf-8');
        // Must NOT forward raw compressed content-length (60) because decompressed bytes are 1350
        assert.equal(response.headers['content-length'], undefined);
        assert.equal(response.headers['content-encoding'], undefined);
        // ETag should be converted to weak validator when auto-decompressed and quoted per RFC 9110
        assert.equal(response.headers.etag, 'W/"CKih16GjycICEAE="');
        // Full decompressed body must be received completely without truncation
        assert.equal(response.body.length, 1350);
        assert.equal(response.body, decompressedContent);
      } finally {
        await testEnv.close();
      }
    });

    void it('should forward Content-Encoding and Content-Length for non-gzip compressed assets (e.g. br)', async () => {
      const rawBrContent = 'brotli-compressed-binary-data';
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/main-5T7P2N6K.js',
          {
            content: rawBrContent,
            emitResponseEvent: {
              statusCode: 200,
              headers: {
                'content-encoding': 'br',
                'content-length': String(Buffer.byteLength(rawBrContent)),
                etag: 'CKih16GjycICEAE=',
              },
            },
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile(
          'main-5T7P2N6K.js',
          res,
          'application/javascript; charset=utf-8',
          true,
          false,
        );
      });

      try {
        const response = await executeRequest(testEnv.server, '/main-5T7P2N6K.js');
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'application/javascript; charset=utf-8');
        assert.equal(response.headers['content-encoding'], 'br');
        assert.equal(response.headers['content-length'], String(Buffer.byteLength(rawBrContent)));
        assert.equal(response.headers.etag, '"CKih16GjycICEAE="');
        assert.equal(response.body, rawBrContent);
      } finally {
        await testEnv.close();
      }
    });

    void it('should preserve Content-Encoding, Content-Length, and strong ETag for noncanonical gzip encodings (e.g. GZIP, identity)', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/uppercase-gzip.js',
          {
            content: 'raw-gzip-bytes',
            emitResponseEvent: {
              statusCode: 200,
              headers: {
                'content-encoding': 'GZIP',
                'content-length': '14',
                etag: 'CKih16GjycICEAE=',
              },
            },
          },
        ],
        [
          'resume_cloudbuild/angular/identity.js',
          {
            content: 'identity-bytes',
            emitResponseEvent: {
              statusCode: 200,
              headers: {
                'content-encoding': 'identity',
                'content-length': '14',
                etag: 'CKih16GjycICEAE=',
              },
            },
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        const file = (req.url ?? '/').slice(1);
        void s.streamFile(file, res, 'application/javascript; charset=utf-8', true, false);
      });

      try {
        // Uppercase GZIP: SDK does not decompress, server forwards original headers and strong ETag
        const upperRes = await executeRequest(testEnv.server, '/uppercase-gzip.js');
        assert.equal(upperRes.statusCode, 200);
        assert.equal(upperRes.headers['content-encoding'], 'GZIP');
        assert.equal(upperRes.headers['content-length'], '14');
        assert.equal(upperRes.headers.etag, '"CKih16GjycICEAE="');
        assert.equal(upperRes.body, 'raw-gzip-bytes');

        // Identity encoding: Content-Encoding is omitted, Content-Length and strong ETag preserved
        const identityRes = await executeRequest(testEnv.server, '/identity.js');
        assert.equal(identityRes.statusCode, 200);
        assert.equal(identityRes.headers['content-encoding'], undefined);
        assert.equal(identityRes.headers['content-length'], '14');
        assert.equal(identityRes.headers.etag, '"CKih16GjycICEAE="');
        assert.equal(identityRes.body, 'identity-bytes');
      } finally {
        await testEnv.close();
      }
    });

    void it('should clear stale headers and return 502 when stream errors after response event but before data', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/styles-5INURTSO.css',
          {
            emitResponseEvent: {
              statusCode: 200,
              headers: {
                'content-length': '500',
                etag: 'stale-etag',
              },
            },
            errorAfterResponse: new Error('CRC32C hash mismatch or gunzip error'),
          },
        ],
      ]);
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger: silentLogger,
      });
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('styles-5INURTSO.css', res, 'text/css; charset=utf-8', true, false);
      });

      try {
        const response = await executeRequest(testEnv.server, '/styles-5INURTSO.css');
        assert.equal(response.statusCode, 502);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        // Stale Content-Length of 500 and ETag must be stripped so 11-byte 'Bad Gateway' is framed correctly
        assert.notEqual(response.headers['content-length'], '500');
        assert.equal(response.headers.etag, undefined);
        assert.equal(response.body, 'Bad Gateway');
      } finally {
        await testEnv.close();
      }
    });

    void it('should return 404 Not Found on missing object without sending 200', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/missing.js',
          {
            errorOnStream: Object.assign(
              new Error('No such object: resume_cloudbuild/missing.js'),
              { code: 404 },
            ),
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('missing.js', res, 'application/javascript; charset=utf-8', false, false);
      });

      try {
        const response = await executeRequest(testEnv.server, '/missing.js');
        assert.equal(response.statusCode, 404);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.body, 'Not Found');
      } finally {
        await testEnv.close();
      }
    });

    void it('should return 404 Not Found for missing object when bucket name contains "bucket"', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/missing.js',
          {
            errorOnStream: Object.assign(
              new Error('No such object: my-bucket/resume_cloudbuild/angular/missing.js'),
              { code: 404 },
            ),
          },
        ],
      ]);
      const service = new GcsStorageService(
        { ...testConfig, bucketName: 'my-bucket' },
        createMockStorage(files),
      );
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('missing.js', res, 'application/javascript; charset=utf-8', false, false);
      });

      try {
        const response = await executeRequest(testEnv.server, '/missing.js');
        assert.equal(response.statusCode, 404);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.body, 'Not Found');
      } finally {
        await testEnv.close();
      }
    });

    void it('should return 404 Not Found for missing object when object path contains "bucket"', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/assets/bucket/missing.js',
          {
            errorOnStream: Object.assign(
              new Error(
                'No such object: test-bucket/resume_cloudbuild/angular/assets/bucket/missing.js',
              ),
              { code: 404 },
            ),
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile(
          'assets/bucket/missing.js',
          res,
          'application/javascript; charset=utf-8',
          false,
          false,
        );
      });

      try {
        const response = await executeRequest(testEnv.server, '/assets/bucket/missing.js');
        assert.equal(response.statusCode, 404);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.body, 'Not Found');
      } finally {
        await testEnv.close();
      }
    });

    void it('should return custom notFoundStatusCode (e.g. 502) when object is missing and notFoundStatusCode is provided on GET', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/missing-index.html',
          {
            errorOnStream: Object.assign(new Error('No such object: missing-index.html'), {
              code: 404,
            }),
          },
        ],
      ]);
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger: silentLogger,
      });
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('missing-index.html', res, 'text/html; charset=utf-8', false, false, 502);
      });

      try {
        const response = await executeRequest(testEnv.server, '/missing-index.html');
        assert.equal(response.statusCode, 502);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.body, 'Bad Gateway');
      } finally {
        await testEnv.close();
      }
    });

    void it('should return 502 Bad Gateway when GCS bucket does not exist', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/any-file.js',
          {
            errorOnStream: Object.assign(new Error('The specified bucket does not exist.'), {
              code: 404,
              errors: [{ reason: 'notFound', message: 'The specified bucket does not exist.' }],
            }),
          },
        ],
      ]);
      const service = new GcsStorageService(
        testConfig,
        createMockStorage(files),
        undefined,
        undefined,
        undefined,
        silentLogger,
      );
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile(
          'any-file.js',
          res,
          'application/javascript; charset=utf-8',
          false,
          false,
        );
      });

      try {
        const response = await executeRequest(testEnv.server, '/any-file.js');
        assert.equal(response.statusCode, 502);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.body, 'Bad Gateway');
      } finally {
        await testEnv.close();
      }
    });

    void it('should destroy response cleanly when stream errors after headersSent is true', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/mid-error.js',
          {
            errorAfterData: new Error('Premature socket termination from GCS'),
          },
        ],
      ]);
      const service = new GcsStorageService(
        testConfig,
        createMockStorage(files),
        undefined,
        undefined,
        undefined,
        silentLogger,
      );
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile(
          'mid-error.js',
          res,
          'application/javascript; charset=utf-8',
          false,
          false,
        );
      });

      try {
        // Request should abort/fail with error or closed connection because headers were already committed
        await assert.rejects(async () => {
          await executeRequest(testEnv.server, '/mid-error.js');
        });
      } finally {
        await testEnv.close();
      }
    });

    void it('should destroy GCS read stream cleanly upon client disconnection', async () => {
      let streamDestroyed = false;
      const customFile = {
        exists: () => Promise.resolve([true]),
        getMetadata: () => Promise.resolve([{ size: 1000 }]),
        createReadStream: () => {
          const stream = new Readable({
            read() {
              // Push some data and hold
              this.push(Buffer.from('chunk1'));
            },
            destroy(err, cb) {
              streamDestroyed = true;
              cb(err);
            },
          });
          return stream;
        },
      } as unknown as File;

      const mockStorage = {
        bucket: () => ({ file: () => customFile }),
      } as unknown as Storage;

      const service = new GcsStorageService(testConfig, mockStorage);
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('long.js', res, 'application/javascript; charset=utf-8', false, false);
      });

      try {
        const address = testEnv.server.address() as AddressInfo;
        await new Promise<void>((resolve) => {
          const req = http.request({
            host: '127.0.0.1',
            port: address.port,
            path: '/long.js',
            method: 'GET',
          });
          req.on('response', (res) => {
            res.on('data', () => {
              // Destroy request mid-stream
              req.destroy();
              setTimeout(() => {
                resolve();
              }, 50);
            });
          });
          req.end();
        });

        assert.equal(streamDestroyed, true);
      } finally {
        await testEnv.close();
      }
    });
  });

  /**
   * End-to-end integration tests for {@link GcsStorageService.streamFile} processing HEAD requests over real sockets.
   *
   * @remarks
   * Covers metadata-only headers extraction, RFC 9110 ETag quoting, gzip Content-Length suppression,
   * brotli header forwarding, missing object 404s, and bucket 502 mapping.
   */
  void describe('Real node:http integration - HEAD requests', () => {
    void it('should return metadata headers with quoted ETag from unquoted JSON API metadata without body on HEAD request', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/main-5T7P2N6K.js',
          {
            metadata: { size: 4096, etag: 'CKih16GjycICEAE=' },
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile(
          'main-5T7P2N6K.js',
          res,
          'application/javascript; charset=utf-8',
          true,
          true,
        );
      });

      try {
        const response = await executeRequest(testEnv.server, '/main-5T7P2N6K.js', 'HEAD');
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'application/javascript; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal(response.headers['content-length'], '4096');
        assert.equal(response.headers.etag, '"CKih16GjycICEAE="');
        assert.equal(response.body, '');
      } finally {
        await testEnv.close();
      }
    });

    void it('should handle gzip-stored asset on HEAD request without compressed Content-Length and with weak quoted ETag', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/main-5T7P2N6K.js',
          {
            metadata: { size: 60, contentEncoding: 'gzip', etag: 'CKih16GjycICEAE=' },
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile(
          'main-5T7P2N6K.js',
          res,
          'application/javascript; charset=utf-8',
          true,
          true,
        );
      });

      try {
        const response = await executeRequest(testEnv.server, '/main-5T7P2N6K.js', 'HEAD');
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'application/javascript; charset=utf-8');
        // Must NOT forward raw compressed content-length (60) or content-encoding per RFC 9110
        assert.equal(response.headers['content-length'], undefined);
        assert.equal(response.headers['content-encoding'], undefined);
        assert.equal(response.headers.etag, 'W/"CKih16GjycICEAE="');
        assert.equal(response.body, '');
      } finally {
        await testEnv.close();
      }
    });

    void it('should forward Content-Encoding and Content-Length for non-gzip compressed assets (e.g. br) on HEAD', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/main-5T7P2N6K.js',
          {
            metadata: { size: 123, contentEncoding: 'br', etag: 'CKih16GjycICEAE=' },
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile(
          'main-5T7P2N6K.js',
          res,
          'application/javascript; charset=utf-8',
          true,
          true,
        );
      });

      try {
        const response = await executeRequest(testEnv.server, '/main-5T7P2N6K.js', 'HEAD');
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'application/javascript; charset=utf-8');
        assert.equal(response.headers['content-encoding'], 'br');
        assert.equal(response.headers['content-length'], '123');
        assert.equal(response.headers.etag, '"CKih16GjycICEAE="');
        assert.equal(response.body, '');
      } finally {
        await testEnv.close();
      }
    });

    void it('should preserve Content-Encoding, Content-Length, and strong ETag for non-gzip encodings on HEAD while treating whitespace-padded gzip as gzip', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/uppercase-gzip.js',
          {
            metadata: { size: 14, contentEncoding: 'GZIP', etag: 'CKih16GjycICEAE=' },
          },
        ],
        [
          'resume_cloudbuild/angular/whitespace-gzip.js',
          {
            metadata: { size: 14, contentEncoding: ' gzip ', etag: 'CKih16GjycICEAE=' },
          },
        ],
        [
          'resume_cloudbuild/angular/identity.js',
          {
            metadata: { size: 14, contentEncoding: 'identity', etag: 'CKih16GjycICEAE=' },
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        const file = (req.url ?? '/').slice(1);
        void s.streamFile(file, res, 'application/javascript; charset=utf-8', true, true);
      });

      try {
        // Uppercase GZIP on HEAD: preserves Content-Encoding, Content-Length, and strong ETag
        const upperRes = await executeRequest(testEnv.server, '/uppercase-gzip.js', 'HEAD');
        assert.equal(upperRes.statusCode, 200);
        assert.equal(upperRes.headers['content-encoding'], 'GZIP');
        assert.equal(upperRes.headers['content-length'], '14');
        assert.equal(upperRes.headers.etag, '"CKih16GjycICEAE="');
        assert.equal(upperRes.body, '');

        // Whitespace-padded gzip on HEAD: mirrors GET auto-decompression by omitting Content-Length & Content-Encoding and returning weak ETag
        const wsRes = await executeRequest(testEnv.server, '/whitespace-gzip.js', 'HEAD');
        assert.equal(wsRes.statusCode, 200);
        assert.equal(wsRes.headers['content-encoding'], undefined);
        assert.equal(wsRes.headers['content-length'], undefined);
        assert.equal(wsRes.headers.etag, 'W/"CKih16GjycICEAE="');
        assert.equal(wsRes.body, '');

        // Identity on HEAD: omits Content-Encoding, preserves Content-Length and strong ETag
        const identityRes = await executeRequest(testEnv.server, '/identity.js', 'HEAD');
        assert.equal(identityRes.statusCode, 200);
        assert.equal(identityRes.headers['content-encoding'], undefined);
        assert.equal(identityRes.headers['content-length'], '14');
        assert.equal(identityRes.headers.etag, '"CKih16GjycICEAE="');
        assert.equal(identityRes.body, '');
      } finally {
        await testEnv.close();
      }
    });

    void it('should return 404 for missing file on HEAD request', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/missing.js',
          {
            errorOnMetadata: Object.assign(new Error('No such object: missing.js'), { code: 404 }),
          },
        ],
      ]);
      const service = new GcsStorageService(testConfig, createMockStorage(files));
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('missing.js', res, 'application/javascript; charset=utf-8', false, true);
      });

      try {
        const response = await executeRequest(testEnv.server, '/missing.js', 'HEAD');
        assert.equal(response.statusCode, 404);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.body, '');
      } finally {
        await testEnv.close();
      }
    });

    void it('should return custom notFoundStatusCode (e.g. 502) on HEAD request when provided', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/missing-index.html',
          {
            errorOnMetadata: Object.assign(new Error('No such object: missing-index.html'), {
              code: 404,
            }),
          },
        ],
      ]);
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger: silentLogger,
      });
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('missing-index.html', res, 'text/html; charset=utf-8', false, true, 502);
      });

      try {
        const response = await executeRequest(testEnv.server, '/missing-index.html', 'HEAD');
        assert.equal(response.statusCode, 502);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.body, '');
      } finally {
        await testEnv.close();
      }
    });

    void it('should return 404 for missing file on HEAD request when bucket name contains "bucket"', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/missing.js',
          {
            errorOnMetadata: Object.assign(
              new Error('No such object: my-bucket/resume_cloudbuild/angular/missing.js'),
              { code: 404 },
            ),
          },
        ],
      ]);
      const service = new GcsStorageService(
        { ...testConfig, bucketName: 'my-bucket' },
        createMockStorage(files),
      );
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('missing.js', res, 'application/javascript; charset=utf-8', false, true);
      });

      try {
        const response = await executeRequest(testEnv.server, '/missing.js', 'HEAD');
        assert.equal(response.statusCode, 404);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.body, '');
      } finally {
        await testEnv.close();
      }
    });

    void it('should return 502 for missing bucket or server error on HEAD request', async () => {
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/broken.js',
          {
            errorOnMetadata: Object.assign(new Error('The specified bucket does not exist.'), {
              code: 404,
            }),
          },
        ],
      ]);
      const service = new GcsStorageService(
        testConfig,
        createMockStorage(files),
        undefined,
        undefined,
        undefined,
        silentLogger,
      );
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('broken.js', res, 'application/javascript; charset=utf-8', false, true);
      });

      try {
        const response = await executeRequest(testEnv.server, '/broken.js', 'HEAD');
        assert.equal(response.statusCode, 502);
        assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
        assert.equal(response.headers['cache-control'], 'no-cache');
        assert.equal(response.body, '');
      } finally {
        await testEnv.close();
      }
    });
  });

  /**
   * Unit tests for {@link isNotFoundError}.
   *
   * @remarks
   * Verifies identification of object-level 404 error patterns across status codes, numeric codes,
   * error messages, and API error reasons while rejecting bucket-level errors to preserve 502 Bad Gateway mapping.
   */
  void describe('isNotFoundError', () => {
    void it('should detect object 404 error shapes', () => {
      assert.equal(isNotFoundError({ code: 404 }), true);
      assert.equal(isNotFoundError({ code: '404' }), true);
      assert.equal(isNotFoundError({ statusCode: 404 }), true);
      assert.equal(isNotFoundError({ status: 404 }), true);
      assert.equal(isNotFoundError(new Error('No such object: file.js')), true);
      assert.equal(isNotFoundError(new Error('No such object: my-bucket/missing.js')), true);
      assert.equal(
        isNotFoundError(new Error('No such object: resume_cloudbuild/assets/bucket/missing.js')),
        true,
      );
      assert.equal(isNotFoundError(new Error('Not Found')), true);
      assert.equal(isNotFoundError({ errors: [{ reason: 'notFound' }] }), true);
    });

    void it('should return false for missing bucket errors (to map to 502)', () => {
      assert.equal(isNotFoundError(new Error('The specified bucket does not exist.')), false);
      assert.equal(
        isNotFoundError({
          code: 404,
          message: 'The specified bucket does not exist.',
          errors: [{ reason: 'notFound', message: 'The specified bucket does not exist.' }],
        }),
        false,
      );
      assert.equal(
        isNotFoundError(new Error('NoSuchBucket: The specified bucket does not exist.')),
        false,
      );
      assert.equal(isNotFoundError(new Error('Bucket "test-bucket" not found')), false);
    });

    void it('should return false for non-404 errors and non-objects', () => {
      assert.equal(isNotFoundError(null), false);
      assert.equal(isNotFoundError(undefined), false);
      assert.equal(isNotFoundError('error string'), false);
      assert.equal(isNotFoundError({ code: 500 }), false);
      assert.equal(isNotFoundError(new Error('Permission denied')), false);
    });
  });

  /**
   * Unit tests for {@link formatEtag}.
   *
   * @remarks
   * Verifies RFC 9110 double-quoting for raw strong ETags, weak-validator `W/` prefix preservation,
   * weak tagging for auto-decompressed payloads, and blank string sanitization.
   */
  void describe('formatEtag', () => {
    void it('should format unquoted etag with double quotes per RFC 9110', () => {
      assert.equal(formatEtag('CKih16GjycICEAE=', false), '"CKih16GjycICEAE="');
      assert.equal(formatEtag('CKih16GjycICEAE=', true), 'W/"CKih16GjycICEAE="');
    });

    void it('should preserve double quotes when etag is already quoted', () => {
      assert.equal(formatEtag('"CKih16GjycICEAE="', false), '"CKih16GjycICEAE="');
      assert.equal(formatEtag('"CKih16GjycICEAE="', true), 'W/"CKih16GjycICEAE="');
    });

    void it('should preserve existing weak etags', () => {
      assert.equal(formatEtag('W/"CKih16GjycICEAE="', false), 'W/"CKih16GjycICEAE="');
      assert.equal(formatEtag('W/"CKih16GjycICEAE="', true), 'W/"CKih16GjycICEAE="');
      assert.equal(formatEtag('W/CKih16GjycICEAE=', false), 'W/"CKih16GjycICEAE="');
      assert.equal(formatEtag('W/CKih16GjycICEAE=', true), 'W/"CKih16GjycICEAE="');
    });

    void it('should return empty string for empty input', () => {
      assert.equal(formatEtag('', false), '');
      assert.equal(formatEtag('   ', false), '');
    });
  });

  /**
   * Unit tests for SOLID components: {@link StoragePathResolver}, {@link RFC9110EtagFormatter}, {@link GcsErrorClassifier}.
   */
  void describe('SOLID Storage Components', () => {
    void it('should resolve storage paths via StoragePathResolver', () => {
      const resolver = new StoragePathResolver('custom/prefix');
      assert.equal(resolver.resolveObjectName('file.js'), 'custom/prefix/file.js');
      assert.equal(resolver.resolveObjectName('/file.js'), 'custom/prefix/file.js');
      assert.equal(resolver.resolveObjectName('custom/prefix/file.js'), 'custom/prefix/file.js');
    });

    void it('should format ETags via RFC9110EtagFormatter', () => {
      const formatter = new RFC9110EtagFormatter();
      assert.equal(formatter.formatEtag('12345', false), '"12345"');
      assert.equal(formatter.formatEtag('12345', true), 'W/"12345"');
    });

    void it('should classify GCS errors via GcsErrorClassifier', () => {
      const classifier = new GcsErrorClassifier();
      assert.equal(classifier.isNotFoundError({ code: 404 }), true);
      assert.equal(classifier.isNotFoundError(new Error('Specified bucket does not exist')), false);
    });

    void it('should allow injecting custom SOLID components into GcsStorageService', () => {
      const customPathResolver = new StoragePathResolver('injected/prefix');
      const customEtagFormatter = new RFC9110EtagFormatter();
      const customErrorClassifier = new GcsErrorClassifier();

      const service = new GcsStorageService(
        testConfig,
        undefined,
        customPathResolver,
        customEtagFormatter,
        customErrorClassifier,
        silentLogger,
      );

      assert.equal(service.resolveObjectName('test.js'), 'injected/prefix/test.js');
    });
  });

  /**
   * Unit and integration tests for Storage Decision Telemetry.
   */
  void describe('Storage Decision Telemetry', () => {
    void it('should log StorageKey decision when resolving object names with bucket prefix', () => {
      const { logger, decisions } = createCapturingLogger();
      const resolver = new StoragePathResolver('resume_cloudbuild/angular', logger);
      const key = resolver.resolveObjectName('main.js');

      assert.equal(key, 'resume_cloudbuild/angular/main.js');
      assert.equal(decisions.length, 1);
      assert.deepEqual(decisions[0], {
        action: 'StorageKey',
        choice: 'resume_cloudbuild/angular/main.js',
        reason: "Applied bucket prefix 'resume_cloudbuild/angular' to relative path",
        level: 'debug',
        rawPath: 'main.js',
        prefix: 'resume_cloudbuild/angular',
      });
    });

    void it('should log StorageKey decision when resolving object names with empty prefix', () => {
      const { logger, decisions } = createCapturingLogger();
      const resolver = new StoragePathResolver('', logger);
      const key = resolver.resolveObjectName('/styles.css');

      assert.equal(key, 'styles.css');
      assert.equal(decisions.length, 1);
      assert.deepEqual(decisions[0], {
        action: 'StorageKey',
        choice: 'styles.css',
        reason: 'No bucket prefix configured, using raw object path',
        level: 'debug',
        rawPath: '/styles.css',
        prefix: '',
      });
    });

    void it('should log StorageKey decision when object name already contains prefix', () => {
      const { logger, decisions } = createCapturingLogger();
      const resolver = new StoragePathResolver('site/assets', logger);
      const key = resolver.resolveObjectName('site/assets/image.png');

      assert.equal(key, 'site/assets/image.png');
      assert.equal(decisions.length, 1);
      assert.deepEqual(decisions[0], {
        action: 'StorageKey',
        choice: 'site/assets/image.png',
        reason: "Object path already contains configured prefix 'site/assets'",
        level: 'debug',
        rawPath: 'site/assets/image.png',
        prefix: 'site/assets',
      });
    });

    void it('should log StorageStream decision for GET and HEAD requests', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/main.js',
          {
            content: 'console.log("main")',
            metadata: { size: 18, etag: '"hash123"' },
          },
        ],
      ]);
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        const isHead = req.method === 'HEAD';
        void s.streamFile('main.js', res, 'application/javascript', true, isHead);
      });

      try {
        await executeRequest(testEnv.server, '/main.js', 'GET');
        await executeRequest(testEnv.server, '/main.js', 'HEAD');

        const streamDecisions = decisions.filter((d) => d.action === 'StorageStream');
        assert.equal(streamDecisions.length, 2);

        assert.equal(streamDecisions[0]?.choice, 'GET byte streaming');
        assert.equal(
          streamDecisions[0]?.reason,
          'Request method is GET, streaming file payload from GCS to HTTP response',
        );
        assert.equal(streamDecisions[0]?.level, 'debug');
        assert.equal(streamDecisions[0]?.isHeadRequest, false);
        assert.equal(streamDecisions[0]?.objectName, 'main.js');
        assert.equal(streamDecisions[0]?.fullPath, 'resume_cloudbuild/angular/main.js');

        assert.equal(streamDecisions[1]?.choice, 'HEAD metadata inspection');
        assert.equal(
          streamDecisions[1]?.reason,
          'Request method is HEAD, inspecting GCS metadata without streaming response body',
        );
        assert.equal(streamDecisions[1]?.level, 'debug');
        assert.equal(streamDecisions[1]?.isHeadRequest, true);
      } finally {
        await testEnv.close();
      }
    });

    void it('should log StorageEtag decision for gzip auto-decompressed payloads and weak ETag conversion', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/bundle.js',
          {
            content: 'decompressed data',
            emitResponseEvent: {
              statusCode: 200,
              headers: {
                'content-encoding': 'gzip',
                'content-length': '50',
                etag: '"strong-etag"',
              },
            },
            metadata: {
              contentEncoding: 'gzip',
              size: 50,
              etag: '"strong-etag"',
            },
          },
        ],
      ]);

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        const isHead = req.method === 'HEAD';
        void s.streamFile('bundle.js', res, 'application/javascript', false, isHead);
      });

      try {
        await executeRequest(testEnv.server, '/bundle.js', 'GET');
        await executeRequest(testEnv.server, '/bundle.js', 'HEAD');

        const etagDecisions = decisions.filter((d) => d.action === 'StorageEtag');
        assert.equal(etagDecisions.length, 2);

        // GET gzip decision
        assert.equal(etagDecisions[0]?.choice, 'Weak ETag (W/"strong-etag")');
        assert.equal(
          etagDecisions[0]?.reason,
          'GCS object has gzip Content-Encoding and will be auto-decompressed on the fly (RFC 9110)',
        );
        assert.equal(etagDecisions[0]?.level, 'debug');
        assert.equal(etagDecisions[0]?.isGzip, true);
        assert.equal(etagDecisions[0]?.omittedHeaders, 'Content-Length, Content-Encoding');

        // HEAD gzip decision
        assert.equal(etagDecisions[1]?.choice, 'Weak ETag (W/"strong-etag")');
        assert.equal(etagDecisions[1]?.isGzip, true);
      } finally {
        await testEnv.close();
      }
    });

    void it('should log StorageEtag decision for non-gzip payload preserving strong ETag', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/styles.css',
          {
            content: 'body {}',
            emitResponseEvent: {
              statusCode: 200,
              headers: {
                'content-length': '7',
                etag: '"strong-styles-123"',
              },
            },
            metadata: {
              size: 7,
              etag: '"strong-styles-123"',
            },
          },
        ],
      ]);

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('styles.css', res, 'text/css', false, false);
      });

      try {
        await executeRequest(testEnv.server, '/styles.css', 'GET');

        const etagDecisions = decisions.filter((d) => d.action === 'StorageEtag');
        assert.equal(etagDecisions.length, 1);
        assert.equal(etagDecisions[0]?.choice, 'Strong ETag ("strong-styles-123")');
        assert.equal(
          etagDecisions[0]?.reason,
          'GCS object is not auto-decompressed by SDK (passthrough), preserving strong validator and Content-Length (RFC 9110)',
        );
        assert.equal(etagDecisions[0]?.level, 'debug');
        assert.equal(etagDecisions[0]?.isGzip, false);
      } finally {
        await testEnv.close();
      }
    });

    void it('should log Strong ETag decisions for noncanonical gzip encodings (GZIP) and Weak ETag for trimmed whitespace gzip on HEAD', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/noncanonical.js',
          {
            content: 'bytes',
            emitResponseEvent: {
              statusCode: 200,
              headers: {
                'content-encoding': 'GZIP',
                'content-length': '5',
                etag: '"noncanonical-etag"',
              },
            },
            metadata: {
              contentEncoding: 'GZIP',
              size: 5,
              etag: '"noncanonical-etag"',
            },
          },
        ],
        [
          'resume_cloudbuild/angular/whitespace.js',
          {
            metadata: {
              contentEncoding: ' gzip ',
              size: 5,
              etag: '"whitespace-etag"',
            },
          },
        ],
      ]);

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        const file = (req.url ?? '/').slice(1);
        const isHead = req.method === 'HEAD';
        void s.streamFile(file, res, 'application/javascript', false, isHead);
      });

      try {
        await executeRequest(testEnv.server, '/noncanonical.js', 'GET');
        await executeRequest(testEnv.server, '/noncanonical.js', 'HEAD');
        await executeRequest(testEnv.server, '/whitespace.js', 'HEAD');

        const etagDecisions = decisions.filter((d) => d.action === 'StorageEtag');
        assert.equal(etagDecisions.length, 3);

        // GET decision: noncanonical uppercase GZIP treated as passthrough strong ETag
        assert.equal(etagDecisions[0]?.choice, 'Strong ETag ("noncanonical-etag")');
        assert.equal(etagDecisions[0]?.isGzip, false);
        assert.equal(etagDecisions[0]?.contentEncoding, 'GZIP');
        assert.equal(
          etagDecisions[0]?.reason,
          'GCS object is not auto-decompressed by SDK (passthrough), preserving strong validator and Content-Length (RFC 9110)',
        );

        // HEAD decision: noncanonical uppercase GZIP treated as passthrough strong ETag
        assert.equal(etagDecisions[1]?.choice, 'Strong ETag ("noncanonical-etag")');
        assert.equal(etagDecisions[1]?.isGzip, false);
        assert.equal(etagDecisions[1]?.contentEncoding, 'GZIP');
        assert.equal(
          etagDecisions[1]?.reason,
          'GCS object is not auto-decompressed by SDK (passthrough), preserving strong validator and Content-Length (RFC 9110)',
        );

        // HEAD whitespace gzip decision: treated as gzip with weak ETag
        assert.equal(etagDecisions[2]?.choice, 'Weak ETag (W/"whitespace-etag")');
        assert.equal(etagDecisions[2]?.isGzip, true);
        assert.equal(etagDecisions[2]?.omittedHeaders, 'Content-Length, Content-Encoding');
      } finally {
        await testEnv.close();
      }
    });

    void it('should log ErrorClassifier decision for 404 object not found vs 502 backend errors', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        ['resume_cloudbuild/angular/found.js', { exists: true }],
      ]);

      const customFile = {
        exists: () =>
          Promise.reject(
            Object.assign(new Error('No such object: missing-rejected.js'), { code: 404 }),
          ),
      } as unknown as File;
      const customStorage = {
        bucket: () => ({
          file: () => customFile,
          getFiles: () => Promise.resolve([[], null]),
        }),
      } as unknown as Storage;

      const serviceWithRejection = new GcsStorageService({
        config: testConfig,
        storageClient: customStorage,
        logger,
      });

      // 404 in fileExists with rejected promise
      const existsMissing = await serviceWithRejection.fileExists('missing-rejected.js');
      assert.equal(existsMissing, false);

      const fileExistsDecisions = decisions.filter((d) => d.action === 'ErrorClassifier');
      assert.equal(fileExistsDecisions.length, 1);
      assert.equal(fileExistsDecisions[0]?.choice, '404 Not Found');
      assert.equal(
        fileExistsDecisions[0]?.reason,
        'GCS error indicated object not found, not missing bucket',
      );
      assert.equal(fileExistsDecisions[0]?.level, 'debug');
      assert.equal(fileExistsDecisions[0]?.is404, true);

      // 404 in streamFile GET
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });
      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('missing.js', res, 'application/javascript', false, false);
      });

      try {
        const res = await executeRequest(testEnv.server, '/missing.js');
        assert.equal(res.statusCode, 404);

        const notFoundDecisions = decisions.filter(
          (d) =>
            d.action === 'ErrorClassifier' && d.path === 'resume_cloudbuild/angular/missing.js',
        );
        assert.equal(notFoundDecisions.length, 1);
        assert.equal(notFoundDecisions[0]?.choice, '404 Not Found');
        assert.equal(
          notFoundDecisions[0]?.reason,
          'GCS error indicated object not found, not missing bucket',
        );
        assert.equal(notFoundDecisions[0]?.level, 'debug');
      } finally {
        await testEnv.close();
      }
    });

    void it('should log ErrorClassifier decision with choice 502 Bad Gateway and mapping reason when notFoundStatusCode is 502 (SPA fallback)', async () => {
      const { logger, decisions, logs } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/index.html',
          {
            errorOnStream: Object.assign(new Error('No such object: index.html'), { code: 404 }),
            errorOnMetadata: Object.assign(new Error('No such object: index.html'), { code: 404 }),
          },
        ],
      ]);

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        const isHead = req.method === 'HEAD';
        void s.streamFile('index.html', res, 'text/html', false, isHead, 502);
      });

      try {
        // GET request with notFoundStatusCode = 502
        const getRes = await executeRequest(testEnv.server, '/index.html', 'GET');
        assert.equal(getRes.statusCode, 502);

        // HEAD request with notFoundStatusCode = 502
        const headRes = await executeRequest(testEnv.server, '/index.html', 'HEAD');
        assert.equal(headRes.statusCode, 502);

        const spaDecisions = decisions.filter((d) => d.action === 'ErrorClassifier');
        assert.equal(spaDecisions.length, 2);

        // GET decision
        assert.equal(spaDecisions[0]?.choice, '502 Bad Gateway');
        assert.equal(
          spaDecisions[0]?.reason,
          'GCS error indicated object not found, mapped to 502 by caller (missing SPA index.html fallback)',
        );
        assert.equal(spaDecisions[0]?.level, 'warn');
        assert.equal(spaDecisions[0]?.statusCode, 502);
        assert.equal(spaDecisions[0]?.is404, true);

        // HEAD decision
        assert.equal(spaDecisions[1]?.choice, '502 Bad Gateway');
        assert.equal(
          spaDecisions[1]?.reason,
          'GCS error indicated object not found, mapped to 502 by caller (missing SPA index.html fallback)',
        );
        assert.equal(spaDecisions[1]?.level, 'warn');
        assert.equal(spaDecisions[1]?.statusCode, 502);
        assert.equal(spaDecisions[1]?.is404, true);

        // Verify error logs were emitted because statusCode is 502 (not 404)
        const errorLogs = logs.filter((l) => l.level === 'error');
        assert.equal(errorLogs.length, 2);
      } finally {
        await testEnv.close();
      }
    });

    void it('should log ErrorClassifier decision with choice 502 Bad Gateway and warning level on storage backend failures (GET and HEAD)', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/backend-err.js',
          {
            errorOnStream: Object.assign(new Error('The specified bucket does not exist.'), {
              code: 404,
              errors: [{ reason: 'notFound', message: 'The specified bucket does not exist.' }],
            }),
            errorOnMetadata: Object.assign(new Error('The specified bucket does not exist.'), {
              code: 404,
              errors: [{ reason: 'notFound', message: 'The specified bucket does not exist.' }],
            }),
          },
        ],
      ]);

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        const isHead = req.method === 'HEAD';
        void s.streamFile('backend-err.js', res, 'application/javascript', false, isHead, 404);
      });

      try {
        const getRes = await executeRequest(testEnv.server, '/backend-err.js', 'GET');
        assert.equal(getRes.statusCode, 502);

        const headRes = await executeRequest(testEnv.server, '/backend-err.js', 'HEAD');
        assert.equal(headRes.statusCode, 502);

        const backendDecisions = decisions.filter((d) => d.action === 'ErrorClassifier');
        assert.equal(backendDecisions.length, 2);

        // GET decision
        assert.equal(backendDecisions[0]?.choice, '502 Bad Gateway');
        assert.equal(
          backendDecisions[0]?.reason,
          'GCS error indicates bucket missing or storage backend failure',
        );
        assert.equal(backendDecisions[0]?.level, 'warn');
        assert.equal(backendDecisions[0]?.statusCode, 502);
        assert.equal(backendDecisions[0]?.is404, false);

        // HEAD decision
        assert.equal(backendDecisions[1]?.choice, '502 Bad Gateway');
        assert.equal(
          backendDecisions[1]?.reason,
          'GCS error indicates bucket missing or storage backend failure',
        );
        assert.equal(backendDecisions[1]?.level, 'warn');
        assert.equal(backendDecisions[1]?.statusCode, 502);
        assert.equal(backendDecisions[1]?.is404, false);
      } finally {
        await testEnv.close();
      }
    });

    void it('should log ErrorClassifier decision with choice abort connection when read stream errors after headersSent', async () => {
      const { logger, decisions, logs } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/mid-stream.js',
          {
            errorAfterData: new Error('Mid-stream storage socket termination'),
          },
        ],
      ]);

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('mid-stream.js', res, 'application/javascript', false, false);
      });

      try {
        await assert.rejects(async () => {
          await executeRequest(testEnv.server, '/mid-stream.js');
        });

        const abortDecisions = decisions.filter((d) => d.action === 'ErrorClassifier');
        assert.equal(abortDecisions.length, 1);
        assert.equal(
          abortDecisions[0]?.choice,
          'abort connection (headers already sent, status 200)',
        );
        assert.equal(
          abortDecisions[0]?.reason,
          'Storage read stream error occurred after HTTP response headers were already sent with status 200',
        );
        assert.equal(abortDecisions[0]?.level, 'warn');
        assert.equal(abortDecisions[0]?.statusCode, 200);
        assert.equal(abortDecisions[0]?.headersSent, true);

        // Check error log
        const errorLogs = logs.filter((l) => l.level === 'error');
        assert.equal(errorLogs.length, 1);
        assert.equal(
          errorLogs[0]?.message,
          'Failed to stream asset from storage (connection aborted mid-stream)',
        );
        assert.ok(errorLogs[0]?.meta[0] instanceof Error);
        assert.deepEqual(errorLogs[0]?.meta[1], {
          path: 'resume_cloudbuild/angular/mid-stream.js',
          statusCode: 200,
          method: 'GET',
        });
      } finally {
        await testEnv.close();
      }
    });
  });

  /**
   * Unit and integration tests for Java-Style Error Formatting in Storage Service.
   */
  void describe('Storage Java-Style Error Formatting & Call Stack', () => {
    void it('should log GET stream 502 errors with Error Detail, Call Stack, and nested Caused by chain', async () => {
      const stream = new MemoryLogStream();
      const realLogger = createAppLogger({
        level: 'debug',
        transports: [new winston.transports.Stream({ stream })],
      });

      const causeErr = new Error('connect ECONNREFUSED 127.0.0.1:443');
      causeErr.name = 'FetchError';
      causeErr.stack = `FetchError: connect ECONNREFUSED 127.0.0.1:443\n    at ClientRequest.<anonymous> (/app/node_modules/@google-cloud/storage/index.js:120:10)\n    at Socket.emit (node:events:517:28)`;

      const storageErr = new Error('Connection refused to Google Cloud Storage', {
        cause: causeErr,
      });
      storageErr.name = 'StorageBackendError';
      storageErr.stack = `StorageBackendError: Connection refused to Google Cloud Storage\n    at GcsStorageService.handleGetRequest (/app/src/storage.ts:550:20)\n    at GcsStorageService.streamFile (/app/src/storage.ts:448:17)`;

      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/corrupt.js',
          {
            errorOnStream: storageErr,
          },
        ],
      ]);

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger: realLogger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('corrupt.js', res, 'application/javascript', false, false);
      });

      try {
        const res = await executeRequest(testEnv.server, '/corrupt.js');
        assert.equal(res.statusCode, 502);

        const output = stream.output;

        // Verify summary line ordering: error detail header
        assert.match(output, /\[error\]: Failed to stream asset from storage/);
        assert.match(output, /Path: resume_cloudbuild\/angular\/corrupt\.js/);
        assert.match(output, /StatusCode: 502/);
        assert.match(output, /Method: GET/);

        // Verify Error Detail line precedes Call Stack
        const errorDetailIndex = output.indexOf(
          'Error Detail: StorageBackendError: Connection refused to Google Cloud Storage',
        );
        const callStackIndex = output.indexOf('Call Stack:');
        assert.ok(errorDetailIndex !== -1, 'Expected "Error Detail:" in log output');
        assert.ok(callStackIndex !== -1, 'Expected "Call Stack:" in log output');
        assert.ok(
          errorDetailIndex < callStackIndex,
          'Expected "Error Detail:" to appear before "Call Stack:"',
        );

        // Verify Call Stack lines
        assert.match(output, /StorageBackendError: Connection refused to Google Cloud Storage/);
        assert.match(output, /at GcsStorageService\.handleGetRequest/);

        // Verify nested Caused by line
        const causedByIndex = output.indexOf('Caused by:');
        assert.ok(causedByIndex !== -1, 'Expected "Caused by:" in log output');
        assert.ok(callStackIndex < causedByIndex, 'Expected "Caused by:" after main call stack');
        assert.match(output, /FetchError: connect ECONNREFUSED 127\.0\.0\.1:443/);
        assert.match(output, /at ClientRequest\.<anonymous>/);
      } finally {
        await testEnv.close();
      }
    });

    void it('should log HEAD metadata 502 errors with Error Detail and Call Stack', async () => {
      const stream = new MemoryLogStream();
      const realLogger = createAppLogger({
        level: 'debug',
        transports: [new winston.transports.Stream({ stream })],
      });

      const metadataErr = new Error('GCS authentication token expired');
      metadataErr.name = 'AuthError';
      metadataErr.stack = `AuthError: GCS authentication token expired\n    at GcsStorageService.handleHeadRequest (/app/src/storage.ts:468:20)`;

      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/secret.js',
          {
            errorOnMetadata: metadataErr,
          },
        ],
      ]);

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger: realLogger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('secret.js', res, 'application/javascript', false, true);
      });

      try {
        const res = await executeRequest(testEnv.server, '/secret.js', 'HEAD');
        assert.equal(res.statusCode, 502);

        const output = stream.output;
        assert.match(output, /\[error\]: Failed to retrieve metadata for asset from storage/);
        assert.match(output, /Path: resume_cloudbuild\/angular\/secret\.js/);
        assert.match(output, /StatusCode: 502/);
        assert.match(output, /Method: HEAD/);

        const errorDetailIndex = output.indexOf(
          'Error Detail: AuthError: GCS authentication token expired',
        );
        const callStackIndex = output.indexOf('Call Stack:');
        assert.ok(errorDetailIndex !== -1, 'Expected "Error Detail:" in log output');
        assert.ok(callStackIndex !== -1, 'Expected "Call Stack:" in log output');
        assert.ok(errorDetailIndex < callStackIndex);
        assert.match(output, /AuthError: GCS authentication token expired/);
      } finally {
        await testEnv.close();
      }
    });

    void it('should log fileExists 502 errors before rethrowing', async () => {
      const stream = new MemoryLogStream();
      const realLogger = createAppLogger({
        level: 'debug',
        transports: [new winston.transports.Stream({ stream })],
      });

      const customFile = {
        exists: () =>
          Promise.reject(
            Object.assign(new Error('The specified bucket does not exist.'), { code: 404 }),
          ),
      } as unknown as File;
      const customStorage = {
        bucket: () => ({ file: () => customFile }),
      } as unknown as Storage;

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: customStorage,
        logger: realLogger,
      });

      await assert.rejects(async () => {
        await service.fileExists('index.html');
      });

      const output = stream.output;
      assert.match(output, /\[error\]: Storage error checking file existence/);
      assert.match(output, /Path: resume_cloudbuild\/angular\/index\.html/);
      assert.match(output, /StatusCode: 502/);
      assert.match(output, /The specified bucket does not exist\./);
    });

    void it('should log midstream read stream errors after headersSent with Error Detail, Call Stack, and actual status 200', async () => {
      const stream = new MemoryLogStream();
      const realLogger = createAppLogger({
        level: 'debug',
        transports: [new winston.transports.Stream({ stream })],
      });

      const streamErr = new Error('Mid-stream storage socket termination');
      streamErr.name = 'StorageSocketError';
      streamErr.stack = `StorageSocketError: Mid-stream storage socket termination\n    at GcsStorageService.handleGetRequest (/app/src/storage.ts:880:20)`;

      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/mid-abort.js',
          {
            errorAfterData: streamErr,
          },
        ],
      ]);

      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger: realLogger,
      });

      const testEnv = await startTestServer(service, (req, res, s) => {
        void s.streamFile('mid-abort.js', res, 'application/javascript', false, false);
      });

      try {
        await assert.rejects(async () => {
          await executeRequest(testEnv.server, '/mid-abort.js');
        });

        const output = stream.output;
        assert.match(
          output,
          /\[error\]: Failed to stream asset from storage \(connection aborted mid-stream\)/,
        );
        assert.match(output, /Path: resume_cloudbuild\/angular\/mid-abort\.js/);
        assert.match(output, /StatusCode: 200/);
        assert.match(output, /Method: GET/);

        const errorDetailIndex = output.indexOf(
          'Error Detail: StorageSocketError: Mid-stream storage socket termination',
        );
        const callStackIndex = output.indexOf('Call Stack:');
        assert.ok(errorDetailIndex !== -1, 'Expected "Error Detail:" in log output');
        assert.ok(callStackIndex !== -1, 'Expected "Call Stack:" in log output');
        assert.ok(errorDetailIndex < callStackIndex);
        assert.match(output, /StorageSocketError: Mid-stream storage socket termination/);
      } finally {
        await testEnv.close();
      }
    });
  });

  /**
   * Unit tests for Storage Dependency Injection and Options.
   */
  void describe('Storage Dependency Injection & Options', () => {
    void it('should initialize GcsStorageService with StorageServiceOptions object', () => {
      const { logger, decisions } = createCapturingLogger();
      const customConfig: ServerConfig = {
        port: 9000,
        host: '127.0.0.1',
        bucketName: 'custom-bucket',
        prefix: 'custom-prefix',
      };

      const options: StorageServiceOptions = {
        config: customConfig,
        logger,
      };

      const service = new GcsStorageService(options);
      const resolved = service.resolveObjectName('app.js');

      assert.equal(resolved, 'custom-prefix/app.js');
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.choice, 'custom-prefix/app.js');
    });

    void it('should initialize createStorageService with StorageServiceOptions object', () => {
      const { logger, decisions } = createCapturingLogger();
      const service = createStorageService({
        config: {
          port: 8080,
          host: '0.0.0.0',
          bucketName: 'opt-bucket',
          prefix: 'opt-prefix',
        },
        logger,
      });

      const resolved = service.resolveObjectName('test.png');
      assert.equal(resolved, 'opt-prefix/test.png');
      assert.equal(decisions.length, 1);
    });

    void it('should initialize createStorageService with positional arguments including logger', () => {
      const { logger, decisions } = createCapturingLogger();
      const service = createStorageService(testConfig, undefined, logger);

      const resolved = service.resolveObjectName('main.js');
      assert.equal(resolved, 'resume_cloudbuild/angular/main.js');
      assert.equal(decisions.length, 1);
    });

    void it('should merge options object with positional storageClient and logger', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([['opt-prefix/app.js', { exists: true }]]);
      const service = createStorageService(
        { config: { ...testConfig, prefix: 'opt-prefix', bucketName: 'opt-bucket' } },
        createMockStorage(files),
        logger,
      );

      const exists = await service.fileExists('app.js');
      assert.equal(exists, true);
      const keyDecisions = decisions.filter((d) => d.action === 'StorageKey');
      assert.equal(keyDecisions.length, 1);
      assert.equal(keyDecisions[0]?.choice, 'opt-prefix/app.js');
    });
  });

  void describe('Storage contract regression', () => {
    void it('should log StorageEtag gzip payloads with original keys and omit-headers choice on GET and HEAD', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/gzip-no-etag.js',
          {
            content: 'decompressed',
            emitResponseEvent: {
              statusCode: 200,
              headers: { 'content-encoding': 'gzip', 'content-length': '12' },
            },
            metadata: { contentEncoding: 'gzip', size: 12 },
          },
        ],
      ]);
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });
      const testEnv = await startTestServer(service, (req, res, s) => {
        const isHead = req.method === 'HEAD';
        void s.streamFile('gzip-no-etag.js', res, 'application/javascript', false, isHead);
      });
      try {
        const getRes = await executeRequest(testEnv.server, '/gzip-no-etag.js', 'GET');
        assert.equal(getRes.statusCode, 200);
        assert.equal(getRes.headers['content-length'], undefined);
        assert.equal(getRes.headers['content-encoding'], undefined);
        assert.equal(getRes.headers.etag, undefined);

        const headRes = await executeRequest(testEnv.server, '/gzip-no-etag.js', 'HEAD');
        assert.equal(headRes.statusCode, 200);
        assert.equal(headRes.headers['content-length'], undefined);
        assert.equal(headRes.headers['content-encoding'], undefined);
        assert.equal(headRes.headers.etag, undefined);

        const etagDecisions = decisions.filter((d) => d.action === 'StorageEtag');
        assert.equal(etagDecisions.length, 2);
        for (const decision of etagDecisions) {
          assert.deepEqual(Object.keys(decision ?? {}), [
            'action',
            'choice',
            'reason',
            'level',
            'rawEtag',
            'formattedEtag',
            'contentEncoding',
            'isGzip',
            'path',
            'omittedHeaders',
          ]);
          assert.equal(decision.choice, 'Omit Content-Length and Content-Encoding');
          assert.equal(decision.formattedEtag, undefined);
          assert.equal(decision.contentEncoding, 'gzip');
          assert.equal(decision.path, 'resume_cloudbuild/angular/gzip-no-etag.js');
        }
      } finally {
        await testEnv.close();
      }
    });

    void it('should not log StorageEtag for non-gzip objects without an ETag on GET and HEAD', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/plain-no-etag.js',
          {
            content: 'plain',
            emitResponseEvent: { statusCode: 200, headers: { 'content-length': '5' } },
            metadata: { size: 5 },
          },
        ],
      ]);
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });
      const testEnv = await startTestServer(service, (req, res, s) => {
        const isHead = req.method === 'HEAD';
        void s.streamFile('plain-no-etag.js', res, 'application/javascript', false, isHead);
      });
      try {
        const getRes = await executeRequest(testEnv.server, '/plain-no-etag.js', 'GET');
        assert.equal(getRes.statusCode, 200);
        assert.equal(getRes.headers['content-length'], '5');
        assert.equal(getRes.headers.etag, undefined);

        const headRes = await executeRequest(testEnv.server, '/plain-no-etag.js', 'HEAD');
        assert.equal(headRes.statusCode, 200);
        assert.equal(headRes.headers['content-length'], '5');
        assert.equal(headRes.headers.etag, undefined);

        assert.equal(decisions.filter((d) => d.action === 'StorageEtag').length, 0);
      } finally {
        await testEnv.close();
      }
    });

    void it('should omit isHead and errorType from fileExists ErrorClassifier payloads', async () => {
      const { logger, decisions } = createCapturingLogger();
      const customFile = {
        exists: () =>
          Promise.reject(Object.assign(new Error('No such object: missing.js'), { code: 404 })),
      } as unknown as File;
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: {
          bucket: () => ({
            file: () => customFile,
            getFiles: () => Promise.resolve([[], null]),
          }),
        } as unknown as Storage,
        logger,
      });
      assert.equal(await service.fileExists('missing.js'), false);
      const payload = decisions.find((d) => d.action === 'ErrorClassifier');
      assert.deepEqual(Object.keys(payload ?? {}), [
        'action',
        'choice',
        'reason',
        'level',
        'statusCode',
        'path',
        'is404',
      ]);
      assert.equal('isHead' in (payload ?? {}), false);
      assert.equal('errorType' in (payload ?? {}), false);
    });

    void it('should map custom notFoundStatusCode to "<code> Bad Gateway" with caller reason', async () => {
      const { logger, decisions } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/spa.html',
          {
            errorOnStream: Object.assign(new Error('No such object: spa.html'), { code: 404 }),
          },
        ],
      ]);
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });
      const testEnv = await startTestServer(service, (_req, res, s) => {
        void s.streamFile('spa.html', res, 'text/html', false, false, 400);
      });
      try {
        const res = await executeRequest(testEnv.server, '/spa.html', 'GET');
        assert.equal(res.statusCode, 400);
        const payload = decisions.find((d) => d.action === 'ErrorClassifier');
        assert.equal(payload?.choice, '400 Bad Gateway');
        assert.equal(
          payload?.reason,
          'GCS error indicated object not found, mapped to 400 by caller (missing SPA index.html fallback)',
        );
        assert.equal(payload?.isHead, false);
      } finally {
        await testEnv.close();
      }
    });

    void it('should handle locator/setup errors in streamFile with 502 Bad Gateway response', async () => {
      const { logger, decisions, logs } = createCapturingLogger();
      const boom = new Error('bucket.file failed');
      const storage = {
        bucket: () => ({
          file: () => {
            throw boom;
          },
          getFiles: () => Promise.resolve([[], null]),
        }),
      } as unknown as Storage;
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: storage,
        logger,
      });
      let statusCode = 200;
      let body = '';
      const fakeRes = {
        headersSent: false,
        destroyed: false,
        writableEnded: false,
        get statusCode() {
          return statusCode;
        },
        set statusCode(val: number) {
          statusCode = val;
        },
        removeHeader() {},
        setHeader() {},
        end(data?: string) {
          if (data) body += data;
        },
        destroy() {},
      } as unknown as http.ServerResponse;

      await service.streamFile('x.js', fakeRes, 'text/plain', false);
      assert.equal(statusCode, 502);
      assert.equal(body, 'Bad Gateway');
      const payload = decisions.find((d) => d.action === 'ErrorClassifier');
      assert.equal(payload?.choice, '502 Bad Gateway');
      assert.equal(
        payload?.reason,
        'GCS error indicates bucket missing or storage backend failure',
      );
      assert.equal(payload?.['is404'], false);
      const errorLog = logs.find((l) => l.level === 'error');
      assert.equal(errorLog?.message, 'Failed to stream asset from storage');
    });

    void it('should treat HEAD errors on a destroyed response as abort-mid-stream', async () => {
      const { logger, decisions, logs } = createCapturingLogger();
      const files = new Map<string, MockFileOptions>([
        [
          'resume_cloudbuild/angular/gone.js',
          {
            errorOnMetadata: Object.assign(new Error('No such object: gone.js'), { code: 404 }),
          },
        ],
      ]);
      const service = new GcsStorageService({
        config: testConfig,
        storageClient: createMockStorage(files),
        logger,
      });
      const fakeRes = {
        headersSent: false,
        destroyed: true,
        writableEnded: false,
        statusCode: 200,
        removeHeader() {},
        setHeader() {},
        end() {
          throw new Error('end should not be called');
        },
        destroy() {
          throw new Error('destroy should not be called');
        },
      } as unknown as http.ServerResponse;
      await service.streamFile('gone.js', fakeRes, 'text/plain', false, true);
      const errorLogs = logs.filter((entry) => entry.level === 'error');
      assert.equal(errorLogs.length, 1);
      assert.equal(
        errorLogs[0]?.message,
        'Failed to retrieve metadata for asset from storage (connection aborted mid-stream)',
      );
      const payload = decisions.find((d) => d.action === 'ErrorClassifier');
      assert.equal(payload?.choice, '404 Not Found');
      assert.equal(payload?.isHead, true);
      assert.equal(payload?.headersSent, undefined);
    });
  });

  describe('StorageObjectLocator & Recursive Search', () => {
    describe('parseTimestampFromDirectory', () => {
      void it('should parse unix timestamp from <unixtime>_<SomeString>', () => {
        assert.equal(parseTimestampFromDirectory('1712345678_v1'), 1712345678);
        assert.equal(parseTimestampFromDirectory('1720000000_release-2024'), 1720000000);
        assert.equal(parseTimestampFromDirectory('0_initial'), 0);
        assert.equal(parseTimestampFromDirectory('1700000000_some_nested_tag_123'), 1700000000);
      });

      void it('should return null for non-timestamped or invalid directory formats', () => {
        assert.equal(parseTimestampFromDirectory('dist'), null);
        assert.equal(parseTimestampFromDirectory('assets'), null);
        assert.equal(parseTimestampFromDirectory('v1_1712345678'), null);
        assert.equal(parseTimestampFromDirectory('1712345678'), null);
        assert.equal(parseTimestampFromDirectory('_build'), null);
        assert.equal(parseTimestampFromDirectory('-100_v1'), null);
        assert.equal(parseTimestampFromDirectory('abc_v1'), null);
        assert.equal(parseTimestampFromDirectory(''), null);
      });
    });

    describe('computeDirectPath', () => {
      void it('should prepend prefix to relative path without duplicating slashes', () => {
        assert.equal(
          computeDirectPath('main.js', 'resume_cloudbuild/angular'),
          'resume_cloudbuild/angular/main.js',
        );
        assert.equal(
          computeDirectPath('main.js', '/resume_cloudbuild/angular/'),
          'resume_cloudbuild/angular/main.js',
        );
      });

      void it('should avoid prepending prefix if already present', () => {
        assert.equal(
          computeDirectPath('resume_cloudbuild/angular/main.js', 'resume_cloudbuild/angular'),
          'resume_cloudbuild/angular/main.js',
        );
      });

      void it('should return clean name when prefix is empty', () => {
        assert.equal(computeDirectPath('main.js', ''), 'main.js');
        assert.equal(computeDirectPath('main.js', '///'), 'main.js');
      });
    });

    describe('extractCandidateMatch & compareCandidates', () => {
      void it('should extract candidate match from timestamped deployment path', () => {
        const file = createMockFile({}, 'resume/1712345678_v1/browser/main.js');
        const match = extractCandidateMatch(file, 'resume', 'main.js');
        assert.ok(match);
        assert.equal(match.unixtime, 1712345678);
        assert.equal(match.directoryName, '1712345678_v1');
        assert.equal(match.fullPath, 'resume/1712345678_v1/browser/main.js');
      });

      void it('should extract candidate match from unversioned directory or root', () => {
        const file1 = createMockFile({}, 'resume/unversioned/main.js');
        const match1 = extractCandidateMatch(file1, 'resume', 'main.js');
        assert.ok(match1);
        assert.equal(match1.unixtime, null);
        assert.equal(match1.directoryName, 'unversioned');

        const file2 = createMockFile({}, 'resume/main.js');
        const match2 = extractCandidateMatch(file2, 'resume', 'main.js');
        assert.ok(match2);
        assert.equal(match2.unixtime, null);
        assert.equal(match2.directoryName, '');
      });

      void it('should return null when basename does not match or is a directory marker', () => {
        const file1 = createMockFile({}, 'resume/1712345678_v1/styles.css');
        assert.equal(extractCandidateMatch(file1, 'resume', 'main.js'), null);

        const file2 = createMockFile({}, 'resume/1712345678_v1/main.js/');
        assert.equal(extractCandidateMatch(file2, 'resume', 'main.js'), null);
      });

      void it('should enforce prefix boundary so other prefixes are excluded', () => {
        const file = createMockFile({}, 'resumextra/1712345678_v1/main.js');
        assert.equal(extractCandidateMatch(file, 'resume', 'main.js'), null);
      });

      void it('should sort timestamped candidates descending from newest to oldest', () => {
        const c1: CandidateFileMatch = {
          file: createMockFile({}, 'resume/1710000000_v1/main.js'),
          fullPath: 'resume/1710000000_v1/main.js',
          unixtime: 1710000000,
          directoryName: '1710000000_v1',
        };
        const c2: CandidateFileMatch = {
          file: createMockFile({}, 'resume/1720000000_v2/main.js'),
          fullPath: 'resume/1720000000_v2/main.js',
          unixtime: 1720000000,
          directoryName: '1720000000_v2',
        };
        const c3: CandidateFileMatch = {
          file: createMockFile({}, 'resume/unversioned/main.js'),
          fullPath: 'resume/unversioned/main.js',
          unixtime: null,
          directoryName: 'unversioned',
        };

        const list = [c1, c3, c2];
        list.sort(compareCandidates);
        assert.equal(list[0]?.fullPath, 'resume/1720000000_v2/main.js');
        assert.equal(list[1]?.fullPath, 'resume/1710000000_v1/main.js');
        assert.equal(list[2]?.fullPath, 'resume/unversioned/main.js');
      });

      void it('should break ties deterministically when timestamps are identical or absent', () => {
        const c1: CandidateFileMatch = {
          file: createMockFile({}, 'resume/1720000000_v2/b/main.js'),
          fullPath: 'resume/1720000000_v2/b/main.js',
          unixtime: 1720000000,
          directoryName: '1720000000_v2',
        };
        const c2: CandidateFileMatch = {
          file: createMockFile({}, 'resume/1720000000_v2/a/main.js'),
          fullPath: 'resume/1720000000_v2/a/main.js',
          unixtime: 1720000000,
          directoryName: '1720000000_v2',
        };
        const list = [c1, c2];
        list.sort(compareCandidates);
        assert.equal(list[0]?.fullPath, 'resume/1720000000_v2/a/main.js');
        assert.equal(list[1]?.fullPath, 'resume/1720000000_v2/b/main.js');
      });
    });

    describe('StorageObjectLocator direct and recursive search execution', () => {
      void it('should resolve directly when object exists at root prefix and bypass getFiles', async () => {
        let getFilesCalled = false;
        const mockBucket = {
          file: (name: string) => {
            return createMockFile({ exists: name === 'app/main.js' }, name);
          },
          getFiles: () => {
            getFilesCalled = true;
            return Promise.resolve([[], null]);
          },
        } as unknown as Bucket;

        const locator = new StorageObjectLocator();
        const res = await locator.locateFile(mockBucket, 'main.js', 'app');
        assert.ok(res);
        assert.equal(res.strategy, 'direct');
        assert.equal(res.fullPath, 'app/main.js');
        assert.equal(getFilesCalled, false);
      });

      void it('should fallback to recursive search on direct 404 and pick newest deployment', async () => {
        const files = new Map<string, MockFileOptions>([
          ['app/1710000000_v1/dist/main.js', { content: 'v1' }],
          ['app/1720000000_v2/dist/main.js', { content: 'v2' }],
          ['app/1715000000_v1.5/dist/main.js', { content: 'v1.5' }],
        ]);
        const storage = createMockStorage(files);
        const locator = new StorageObjectLocator();
        const res = await locator.locateFile(storage.bucket('b'), 'main.js', 'app');
        assert.ok(res);
        assert.equal(res.strategy, 'recursive');
        assert.equal(res.fullPath, 'app/1720000000_v2/dist/main.js');
        assert.equal(res.unixtime, 1720000000);
      });

      void it('should locate deeply nested files within a timestamped deployment directory', async () => {
        const files = new Map<string, MockFileOptions>([
          ['app/1725000000_build/nested/deep/bundle.css', { content: 'body { color: red; }' }],
        ]);
        const storage = createMockStorage(files);
        const locator = new StorageObjectLocator();
        const res = await locator.locateFile(storage.bucket('b'), 'bundle.css', 'app');
        assert.ok(res);
        assert.equal(res.strategy, 'recursive');
        assert.equal(res.fullPath, 'app/1725000000_build/nested/deep/bundle.css');
        assert.equal(res.unixtime, 1725000000);
      });

      void it('should return null when object is not found directly or recursively', async () => {
        const files = new Map<string, MockFileOptions>([
          ['app/1720000000_v2/dist/other.js', { content: 'other' }],
        ]);
        const storage = createMockStorage(files);
        const locator = new StorageObjectLocator();
        const res = await locator.locateFile(storage.bucket('b'), 'nonexistent.js', 'app');
        assert.equal(res, null);
      });

      void it('should return null when object name is empty', async () => {
        const storage = createMockStorage(new Map());
        const locator = new StorageObjectLocator();
        const res = await locator.locateFile(storage.bucket('b'), '', 'app');
        assert.equal(res, null);
      });

      void it('should handle pagination when bucket.getFiles returns nextQuery token', async () => {
        const file1 = createMockFile({}, 'app/1710000000_v1/main.js');
        const file2 = createMockFile({}, 'app/1730000000_v3/main.js');
        let callCount = 0;
        const mockBucket = {
          file: (name: string) => createMockFile({ exists: false }, name),
          getFiles: (query?: { prefix?: string; pageToken?: string }) => {
            callCount += 1;
            if (!query?.pageToken) {
              return Promise.resolve([[file1], { prefix: 'app/', pageToken: 'page2' }]);
            }
            return Promise.resolve([[file2], null]);
          },
        } as unknown as Bucket;

        const locator = new StorageObjectLocator();
        const res = await locator.locateFile(mockBucket, 'main.js', 'app');
        assert.ok(res);
        assert.equal(callCount, 2);
        assert.equal(res.fullPath, 'app/1730000000_v3/main.js');
        assert.equal(res.unixtime, 1730000000);
      });

      void it('should pass normalized search prefix with trailing slash or empty query to bucket.getFiles', async () => {
        const capturedQueries: Array<Record<string, unknown> | undefined> = [];
        const mockBucket = {
          file: (name: string) => createMockFile({ exists: false }, name),
          getFiles: (query?: Record<string, unknown>) => {
            capturedQueries.push(query);
            return Promise.resolve([[], null]);
          },
        } as unknown as Bucket;

        const locator = new StorageObjectLocator();

        // 1. Unnormalized prefix 'app' -> formatted to 'app/'
        await locator.locateFile(mockBucket, 'main.js', 'app');
        assert.equal(capturedQueries.length, 1);
        assert.deepEqual(capturedQueries[0], { prefix: 'app/', autoPaginate: false });

        // 2. Prefix with leading/trailing slashes '/app/' -> formatted to 'app/'
        await locator.locateFile(mockBucket, 'main.js', '/app/');
        assert.equal(capturedQueries.length, 2);
        assert.deepEqual(capturedQueries[1], { prefix: 'app/', autoPaginate: false });

        // 3. Root / empty prefix '' -> formatted to '' (no prefix property)
        await locator.locateFile(mockBucket, 'main.js', '');
        assert.equal(capturedQueries.length, 3);
        assert.deepEqual(capturedQueries[2], { autoPaginate: false });

        // 4. Root slash prefix '/' -> formatted to '' (no prefix property)
        await locator.locateFile(mockBucket, 'main.js', '/');
        assert.equal(capturedQueries.length, 4);
        assert.deepEqual(capturedQueries[3], { autoPaginate: false });
      });

      void it('should reject when getFiles fails with 404 error (e.g. bucket not found or storage API error)', async () => {
        const notFoundError = Object.assign(new Error('Bucket not found'), { code: 404 });
        const mockBucket = {
          file: (name: string) => createMockFile({ exists: false }, name),
          getFiles: () => Promise.reject(notFoundError),
        } as unknown as Bucket;

        const locator = new StorageObjectLocator();
        await assert.rejects(locator.locateFile(mockBucket, 'main.js', 'app'), notFoundError);
      });

      void it('should rethrow 500 error from getFiles', async () => {
        const serverError = Object.assign(new Error('Internal storage error'), { code: 500 });
        const mockBucket = {
          file: (name: string) => createMockFile({ exists: false }, name),
          getFiles: () => Promise.reject(serverError),
        } as unknown as Bucket;

        const locator = new StorageObjectLocator();
        await assert.rejects(locator.locateFile(mockBucket, 'main.js', 'app'), serverError);
      });

      void it('should rethrow 500 error from direct existence check', async () => {
        const serverError = Object.assign(new Error('Storage unavailable'), { code: 503 });
        const mockBucket = {
          file: (name: string) => ({
            name,
            exists: () => Promise.reject(serverError),
          }),
        } as unknown as Bucket;

        const locator = new StorageObjectLocator();
        await assert.rejects(locator.locateFile(mockBucket, 'main.js', 'app'), serverError);
      });
    });

    describe('StorageObjectLocator telemetry decision logging', () => {
      void it('should log direct hit decision with action StorageLocator', async () => {
        const { logger, decisions } = createCapturingLogger();
        const files = new Map<string, MockFileOptions>([['app/main.js', { content: 'direct' }]]);
        const storage = createMockStorage(files);
        const locator = new StorageObjectLocator(undefined, logger);

        await locator.locateFile(storage.bucket('b'), 'main.js', 'app');
        const decision = decisions.find((d) => d.action === 'StorageLocator');
        assert.ok(decision);
        assert.equal(decision.choice, 'direct: app/main.js');
        assert.equal(decision['strategy'], 'direct');
        assert.equal(decision['fullPath'], 'app/main.js');
        assert.equal(decision['objectName'], 'main.js');
        assert.equal(decision['prefix'], 'app');
      });

      void it('should log recursive discovery decision with timestamp and fullPath', async () => {
        const { logger, decisions } = createCapturingLogger();
        const files = new Map<string, MockFileOptions>([
          ['app/1720000000_v2/dist/main.js', { content: 'v2' }],
        ]);
        const storage = createMockStorage(files);
        const locator = new StorageObjectLocator(undefined, logger);

        await locator.locateFile(storage.bucket('b'), 'main.js', 'app');
        const decision = decisions.find((d) => d.action === 'StorageLocator');
        assert.ok(decision);
        assert.equal(decision.choice, 'recursive: app/1720000000_v2/dist/main.js');
        assert.equal(decision['strategy'], 'recursive');
        assert.equal(decision['fullPath'], 'app/1720000000_v2/dist/main.js');
        assert.equal(decision['unixtime'], 1720000000);
      });

      void it('should log not found decision when object is absent', async () => {
        const { logger, decisions } = createCapturingLogger();
        const storage = createMockStorage(new Map());
        const locator = new StorageObjectLocator(undefined, logger);

        await locator.locateFile(storage.bucket('b'), 'missing.js', 'app');
        const decision = decisions.find((d) => d.action === 'StorageLocator');
        assert.ok(decision);
        assert.equal(decision.choice, 'not found');
        assert.equal(decision['strategy'], 'none');
        assert.equal(decision['objectName'], 'missing.js');
      });
    });

    describe('StorageService integration with custom locator', () => {
      void it('should resolve injected custom locator via StorageServiceOptions object', () => {
        const customLocator: IStorageObjectLocator = {
          locateFile: (_bucket, name, prefix) =>
            Promise.resolve({
              file: createMockFile({}, `${prefix}/${name}`),
              fullPath: `${prefix}/${name}`,
              strategy: 'direct',
            }),
        };

        const deps = resolveStorageDeps({
          config: testConfig,
          locator: customLocator,
        });

        assert.equal(deps.objectLocator, customLocator);
      });

      void it('should resolve injected custom locator via positional arguments', () => {
        const customLocator: IStorageObjectLocator = {
          locateFile: (_bucket, name, prefix) =>
            Promise.resolve({
              file: createMockFile({}, `${prefix}/${name}`),
              fullPath: `${prefix}/${name}`,
              strategy: 'direct',
            }),
        };

        const deps = resolveStorageDeps(
          testConfig,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          customLocator,
        );

        assert.equal(deps.objectLocator, customLocator);
      });

      void it('should instantiate default StorageObjectLocator with injected errorClassifier and logger', () => {
        const customClassifier = new GcsErrorClassifier();
        const { logger } = createCapturingLogger();

        const deps = resolveStorageDeps(
          testConfig,
          undefined,
          undefined,
          undefined,
          customClassifier,
          logger,
        );

        assert.ok(deps.objectLocator instanceof StorageObjectLocator);
        assert.equal(
          (deps.objectLocator as unknown as { errorClassifier: unknown }).errorClassifier,
          customClassifier,
        );
        assert.equal((deps.objectLocator as unknown as { logger: unknown }).logger, logger);
      });

      void it('should inject custom locator into GcsStorageService and invoke it', async () => {
        let customLocateCalled = false;
        const customLocator: IStorageObjectLocator = {
          locateFile: (_bucket, name, prefix) => {
            customLocateCalled = true;
            return Promise.resolve({
              file: createMockFile({}, `${prefix}/${name}`),
              fullPath: `${prefix}/${name}`,
              strategy: 'direct',
            });
          },
        };

        const service = new GcsStorageService({
          config: testConfig,
          storageClient: createMockStorage(new Map()),
          locator: customLocator,
        });

        assert.ok(service);
        const resolvedDeps = (
          service as unknown as { deps: { objectLocator: IStorageObjectLocator } }
        ).deps;
        assert.equal(resolvedDeps.objectLocator, customLocator);

        const result = await resolvedDeps.objectLocator.locateFile(
          (service as unknown as { bucket: Bucket }).bucket,
          'main.js',
          testConfig.prefix,
        );
        assert.equal(customLocateCalled, true);
        assert.ok(result);
        assert.equal(result.strategy, 'direct');
        assert.equal(result.fullPath, `${testConfig.prefix}/main.js`);
      });
    });

    describe('GcsStorageService Recursive Search & Streaming Pipeline Integration', () => {
      void it('should verify fileExists returns true for relocated files in timestamped directories', async () => {
        const files = new Map<string, MockFileOptions>([
          [
            'resume_cloudbuild/angular/1720000000_release-2024/dist/browser/main.js',
            { exists: true },
          ],
        ]);
        const service = new GcsStorageService(testConfig, createMockStorage(files));

        const exists = await service.fileExists('main.js');
        assert.equal(exists, true);

        const notFound = await service.fileExists('non-existent.js');
        assert.equal(notFound, false);
      });

      void it('should stream relocated file from newest timestamp deployment directory on GET', async () => {
        const { logger, decisions } = createCapturingLogger();
        const files = new Map<string, MockFileOptions>([
          [
            'resume_cloudbuild/angular/1710000000_v1/dist/browser/main.js',
            {
              content: 'console.log("v1");',
              metadata: { etag: 'etag-v1', size: 18 },
              emitResponseEvent: {
                statusCode: 200,
                headers: { etag: 'etag-v1', 'content-length': '18' },
              },
            },
          ],
          [
            'resume_cloudbuild/angular/1720000000_v2/dist/browser/main.js',
            {
              content: 'console.log("v2");',
              metadata: { etag: 'etag-v2', size: 18 },
              emitResponseEvent: {
                statusCode: 200,
                headers: { etag: 'etag-v2', 'content-length': '18' },
              },
            },
          ],
        ]);

        const service = new GcsStorageService({
          config: testConfig,
          storageClient: createMockStorage(files),
          logger,
        });

        const testEnv = await startTestServer(service, (_req, res, s) => {
          void s.streamFile('main.js', res, 'application/javascript; charset=utf-8', false, false);
        });

        try {
          const res = await executeRequest(testEnv.server, '/main.js', 'GET');
          assert.equal(res.statusCode, 200);
          assert.equal(res.body, 'console.log("v2");');
          assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
          assert.equal(res.headers['cache-control'], 'public, max-age=0, must-revalidate');
          assert.equal(res.headers['etag'], '"etag-v2"');

          const locateDecision = decisions.find((d) => d.action === 'StorageLocator');
          assert.ok(locateDecision);
          assert.equal(
            locateDecision.choice,
            'recursive: resume_cloudbuild/angular/1720000000_v2/dist/browser/main.js',
          );
          assert.equal(locateDecision['strategy'], 'recursive');
          assert.equal(
            locateDecision['fullPath'],
            'resume_cloudbuild/angular/1720000000_v2/dist/browser/main.js',
          );
          assert.equal(locateDecision['unixtime'], 1720000000);

          const streamDecision = decisions.find((d) => d.action === 'StorageStream');
          assert.ok(streamDecision);
          assert.equal(
            streamDecision['fullPath'],
            'resume_cloudbuild/angular/1720000000_v2/dist/browser/main.js',
          );

          const etagDecision = decisions.find((d) => d.action === 'StorageEtag');
          assert.ok(etagDecision);
          assert.equal(etagDecision['rawEtag'], 'etag-v2');
          assert.equal(etagDecision['formattedEtag'], '"etag-v2"');
        } finally {
          await testEnv.close();
        }
      });

      void it('should set immutable Cache-Control header when streaming relocated hashed asset', async () => {
        const files = new Map<string, MockFileOptions>([
          [
            'resume_cloudbuild/angular/1720000000_v2/dist/browser/main-5T7P2N6K.js',
            {
              content: 'console.log("hashed");',
              metadata: { etag: 'etag-hashed', size: 22 },
              emitResponseEvent: {
                statusCode: 200,
                headers: { etag: 'etag-hashed', 'content-length': '22' },
              },
            },
          ],
        ]);

        const service = new GcsStorageService(testConfig, createMockStorage(files));
        const testEnv = await startTestServer(service, (_req, res, s) => {
          void s.streamFile(
            'main-5T7P2N6K.js',
            res,
            'application/javascript; charset=utf-8',
            true,
            false,
          );
        });

        try {
          const res = await executeRequest(testEnv.server, '/main-5T7P2N6K.js', 'GET');
          assert.equal(res.statusCode, 200);
          assert.equal(res.body, 'console.log("hashed");');
          assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
        } finally {
          await testEnv.close();
        }
      });

      void it('should handle HEAD requests for relocated assets without returning a body', async () => {
        const { logger, decisions } = createCapturingLogger();
        const files = new Map<string, MockFileOptions>([
          [
            'resume_cloudbuild/angular/1725000000_rel/styles.css',
            {
              content: 'body { color: red; }',
              metadata: { etag: 'etag-css', size: 20 },
            },
          ],
        ]);

        const service = new GcsStorageService({
          config: testConfig,
          storageClient: createMockStorage(files),
          logger,
        });

        const testEnv = await startTestServer(service, (_req, res, s) => {
          void s.streamFile('styles.css', res, 'text/css; charset=utf-8', false, true);
        });

        try {
          const res = await executeRequest(testEnv.server, '/styles.css', 'HEAD');
          assert.equal(res.statusCode, 200);
          assert.equal(res.body, '');
          assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
          assert.equal(res.headers['cache-control'], 'public, max-age=0, must-revalidate');
          assert.equal(res.headers['etag'], '"etag-css"');
          assert.equal(res.headers['content-length'], '20');

          const locateDecision = decisions.find((d) => d.action === 'StorageLocator');
          assert.ok(locateDecision);
          assert.equal(locateDecision['strategy'], 'recursive');
          assert.equal(
            locateDecision['fullPath'],
            'resume_cloudbuild/angular/1725000000_rel/styles.css',
          );
        } finally {
          await testEnv.close();
        }
      });

      void it('should return 404 when object is not found directly or recursively', async () => {
        const { logger, decisions } = createCapturingLogger();
        const files = new Map<string, MockFileOptions>([
          ['resume_cloudbuild/angular/1720000000_v2/dist/other.js', { exists: true }],
        ]);

        const service = new GcsStorageService({
          config: testConfig,
          storageClient: createMockStorage(files),
          logger,
        });

        const testEnv = await startTestServer(service, (_req, res, s) => {
          void s.streamFile(
            'missing.js',
            res,
            'application/javascript; charset=utf-8',
            false,
            false,
          );
        });

        try {
          const res = await executeRequest(testEnv.server, '/missing.js', 'GET');
          assert.equal(res.statusCode, 404);
          assert.equal(res.body, 'Not Found');

          const locateDecision = decisions.find((d) => d.action === 'StorageLocator');
          assert.ok(locateDecision);
          assert.equal(locateDecision.choice, 'not found');
          assert.equal(locateDecision['strategy'], 'none');

          const errorDecision = decisions.find((d) => d.action === 'ErrorClassifier');
          assert.ok(errorDecision);
          assert.equal(errorDecision.choice, '404 Not Found');
          assert.equal(errorDecision['statusCode'], 404);
        } finally {
          await testEnv.close();
        }
      });

      void it('should return 502 when index.html is missing with notFoundStatusCode 502', async () => {
        const { logger, decisions } = createCapturingLogger();
        const files = new Map<string, MockFileOptions>();

        const service = new GcsStorageService({
          config: testConfig,
          storageClient: createMockStorage(files),
          logger,
        });

        const testEnv = await startTestServer(service, (_req, res, s) => {
          void s.streamFile('index.html', res, 'text/html; charset=utf-8', false, false, 502);
        });

        try {
          const res = await executeRequest(testEnv.server, '/index.html', 'GET');
          assert.equal(res.statusCode, 502);
          assert.equal(res.body, 'Bad Gateway');

          const errorDecision = decisions.find((d) => d.action === 'ErrorClassifier');
          assert.ok(errorDecision);
          assert.equal(errorDecision.choice, '502 Bad Gateway');
          assert.equal(errorDecision['statusCode'], 502);
        } finally {
          await testEnv.close();
        }
      });

      void it('should bypass recursive getFiles when direct key exists', async () => {
        let getFilesCalled = false;
        const files = new Map<string, MockFileOptions>([
          [
            'resume_cloudbuild/angular/main.js',
            {
              content: 'direct-content',
              metadata: { etag: 'direct-etag', size: 14 },
              emitResponseEvent: {
                statusCode: 200,
                headers: { etag: 'direct-etag', 'content-length': '14' },
              },
            },
          ],
        ]);

        const mockBucket: Bucket = {
          file: (name: string) => {
            const opts = files.get(name) ?? { exists: false };
            return createMockFile(opts, name);
          },
          getFiles: () => {
            getFilesCalled = true;
            return Promise.resolve([[], null]);
          },
        } as unknown as Bucket;

        const customStorage = {
          bucket: () => mockBucket,
        } as unknown as Storage;

        const service = new GcsStorageService(testConfig, customStorage);
        const testEnv = await startTestServer(service, (_req, res, s) => {
          void s.streamFile('main.js', res, 'application/javascript', false, false);
        });

        try {
          const res = await executeRequest(testEnv.server, '/main.js', 'GET');
          assert.equal(res.statusCode, 200);
          assert.equal(res.body, 'direct-content');
          assert.equal(getFilesCalled, false);
        } finally {
          await testEnv.close();
        }
      });

      void it('should return 502 Bad Gateway and ErrorClassifier decision when direct exists() fails with 500/503 for GET and HEAD', async () => {
        const { logger, decisions, logs } = createCapturingLogger();
        const customFile = {
          exists: () =>
            Promise.reject(Object.assign(new Error('GCS 503 Service Unavailable'), { code: 503 })),
        } as unknown as File;
        const mockBucket = {
          file: () => customFile,
          getFiles: () => Promise.resolve([[], null]),
        } as unknown as Bucket;
        const storage = { bucket: () => mockBucket } as unknown as Storage;
        const service = new GcsStorageService({
          config: testConfig,
          storageClient: storage,
          logger,
        });

        const testEnv = await startTestServer(service, (req, res, s) => {
          const isHead = req.method === 'HEAD';
          void s.streamFile('styles.css', res, 'text/css', false, isHead);
        });

        try {
          // GET
          const getRes = await executeRequest(testEnv.server, '/styles.css', 'GET');
          assert.equal(getRes.statusCode, 502);
          assert.equal(getRes.body, 'Bad Gateway');

          // HEAD
          const headRes = await executeRequest(testEnv.server, '/styles.css', 'HEAD');
          assert.equal(headRes.statusCode, 502);
          assert.equal(headRes.body, '');

          const errorDecisions = decisions.filter((d) => d.action === 'ErrorClassifier');
          assert.equal(errorDecisions.length, 2);
          assert.equal(errorDecisions[0]?.choice, '502 Bad Gateway');
          assert.equal(errorDecisions[0]?.['is404'], false);
          assert.equal(errorDecisions[1]?.choice, '502 Bad Gateway');
          assert.equal(errorDecisions[1]?.['isHead'], true);
          assert.equal(errorDecisions[1]?.['is404'], false);

          const errorLogs = logs.filter((l) => l.level === 'error');
          assert.equal(errorLogs.length, 2);
        } finally {
          await testEnv.close();
        }
      });

      void it('should return 502 Bad Gateway when getFiles rejects with 403, 503, or listing 404 for GET, HEAD, and SPA fallback', async () => {
        const errorScenarios = [
          {
            name: '403 Forbidden',
            err: Object.assign(new Error('Caller does not have storage.objects.list permission'), {
              code: 403,
            }),
          },
          {
            name: '503 Unavailable',
            err: Object.assign(new Error('Service Unavailable'), { code: 503 }),
          },
          {
            name: '404 Listing / Bucket Missing',
            err: Object.assign(new Error('The specified bucket does not exist.'), { code: 404 }),
          },
          {
            name: 'Generic 404 Listing',
            err: Object.assign(new Error('Not Found'), { code: 404 }),
          },
        ];

        for (const scenario of errorScenarios) {
          const { logger, decisions } = createCapturingLogger();
          const mockFile = { exists: () => Promise.resolve([false]) } as unknown as File;
          const mockBucket = {
            file: () => mockFile,
            getFiles: () => Promise.reject(scenario.err),
          } as unknown as Bucket;
          const storage = { bucket: () => mockBucket } as unknown as Storage;
          const service = new GcsStorageService({
            config: testConfig,
            storageClient: storage,
            logger,
          });

          const testEnv = await startTestServer(service, (req, res, s) => {
            const isHead = req.method === 'HEAD';
            const isSpa = req.url === '/index.html';
            const notFoundStatus = isSpa ? 502 : 404;
            void s.streamFile(
              isSpa ? 'index.html' : 'bundle.js',
              res,
              isSpa ? 'text/html' : 'application/javascript',
              false,
              isHead,
              notFoundStatus,
            );
          });

          try {
            // GET regular missing asset
            const getRes = await executeRequest(testEnv.server, '/bundle.js', 'GET');
            assert.equal(getRes.statusCode, 502, `Expected 502 for ${scenario.name} GET`);
            assert.equal(getRes.body, 'Bad Gateway');

            // HEAD regular missing asset
            const headRes = await executeRequest(testEnv.server, '/bundle.js', 'HEAD');
            assert.equal(headRes.statusCode, 502, `Expected 502 for ${scenario.name} HEAD`);
            assert.equal(headRes.body, '');

            // SPA index.html fallback
            const spaRes = await executeRequest(testEnv.server, '/index.html', 'GET');
            assert.equal(spaRes.statusCode, 502, `Expected 502 for ${scenario.name} SPA fallback`);
            assert.equal(spaRes.body, 'Bad Gateway');

            const errorDecisions = decisions.filter((d) => d.action === 'ErrorClassifier');
            assert.equal(
              errorDecisions.length,
              3,
              `Expected 3 ErrorClassifier decisions for ${scenario.name}`,
            );
            for (const dec of errorDecisions) {
              assert.equal(dec.choice, '502 Bad Gateway');
              assert.equal(dec['statusCode'], 502);
              assert.equal(
                dec['is404'],
                false,
                `Expected is404=false for listing failure in ${scenario.name}`,
              );
            }
          } finally {
            await testEnv.close();
          }
        }
      });

      void it('should throw error from fileExists when getFiles rejects (never return false on listing failures)', async () => {
        const errorScenarios = [
          Object.assign(new Error('Permission denied'), { code: 403 }),
          Object.assign(new Error('Backend 500 failure'), { code: 500 }),
          Object.assign(new Error('Service Unavailable'), { code: 503 }),
          Object.assign(new Error('Not Found'), { code: 404 }),
        ];

        for (const err of errorScenarios) {
          const { logger, decisions, logs } = createCapturingLogger();
          const mockFile = { exists: () => Promise.resolve([false]) } as unknown as File;
          const mockBucket = {
            file: () => mockFile,
            getFiles: () => Promise.reject(err),
          } as unknown as Bucket;
          const storage = { bucket: () => mockBucket } as unknown as Storage;
          const service = new GcsStorageService({
            config: testConfig,
            storageClient: storage,
            logger,
          });

          await assert.rejects(
            async () => {
              await service.fileExists('check.js');
            },
            (thrown: unknown) => thrown === err,
          );

          const classifierDecisions = decisions.filter((d) => d.action === 'ErrorClassifier');
          assert.equal(classifierDecisions.length, 1);
          assert.equal(classifierDecisions[0]?.choice, '502 Bad Gateway');
          assert.equal(classifierDecisions[0]?.['is404'], false);

          const errorLogs = logs.filter((l) => l.level === 'error');
          assert.equal(errorLogs.length, 1);
          assert.equal(errorLogs[0]?.message, 'Storage error checking file existence');
        }
      });
    });
  });
});
