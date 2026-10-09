import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import process from 'node:process';
import winston from 'winston';
import {
  logger,
  createAppLogger,
  WinstonAppLogger,
  logDecision,
  toAppLogger,
  resolveLogLevel,
  VALID_LOG_LEVELS,
  DECISION_SYMBOL,
  DECISION_LOG_TYPE,
  isErrorObject,
  isPotentialError,
  sanitizeErrorMessage,
  formatJavaStyleStackTrace,
  formatErrorDetail,
  formatJavaStyleError,
  formatDecision,
  formatConsoleOutput,
  escapeForConsole,
  escapeCallStack,
  safeStringify,
  sanitizeAllErrorsInValue,
  type AppLogger,
  type DecisionLogPayload,
  type LogLevel,
} from '../src/logger/logger.ts';

/**
 * Custom memory writable stream to capture formatted log output in tests.
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

/**
 * Creates a test logger writing to a memory stream using createAppLogger.
 */
function createMemoryLogger(
  options: {
    json?: boolean;
    level?: LogLevel;
    silent?: boolean;
    defaultMeta?: Record<string, unknown>;
  } = {},
): {
  appLogger: AppLogger;
  stream: MemoryLogStream;
} {
  const stream = new MemoryLogStream();

  const appLogger = createAppLogger({
    level: options.level ?? 'debug',
    json: options.json,
    silent: options.silent,
    defaultMeta: options.defaultMeta,
    transports: [
      new winston.transports.Stream({
        stream,
      }),
    ],
  });

  return {
    appLogger,
    stream,
  };
}

void describe('Application Logger Module', () => {
  void describe('safeStringify utility', () => {
    void it('should stringify primitive types accurately', () => {
      assert.equal(safeStringify('test'), 'test');
      assert.equal(safeStringify(123), '123');
      assert.equal(safeStringify(true), 'true');
      assert.equal(safeStringify(false), 'false');
      assert.equal(safeStringify(BigInt(42)), '42');
      assert.equal(safeStringify(undefined), 'undefined');
      assert.equal(safeStringify(null), 'null');
      assert.equal(safeStringify(Symbol('token')), 'Symbol(token)');
    });

    void it('should stringify Error instances using message or name', () => {
      assert.equal(safeStringify(new Error('something failed')), 'something failed');
      const emptyErr = new Error('');
      emptyErr.name = 'CustomEmptyError';
      assert.equal(safeStringify(emptyErr), 'CustomEmptyError');
    });

    void it('should stringify JSON objects and handle circular objects gracefully', () => {
      assert.equal(safeStringify({ key: 'val', num: 1 }), '{"key":"val","num":1}');

      const circular: Record<string, unknown> = { key: 'circle' };
      circular['self'] = circular;
      assert.equal(safeStringify(circular), '[Unserializable Object]');
    });

    void it('should stringify function values to null', () => {
      assert.equal(
        safeStringify(() => 1),
        'null',
      );
      function secretFn() {
        return 'SECRET_TOKEN';
      }
      assert.equal(safeStringify(secretFn), 'null');
    });
  });

  void describe('resolveLogLevel and isErrorObject utilities', () => {
    void it('should validate standard log levels', () => {
      assert.equal(VALID_LOG_LEVELS.size, 5);
      assert.ok(VALID_LOG_LEVELS.has('error'));
      assert.ok(VALID_LOG_LEVELS.has('warn'));
      assert.ok(VALID_LOG_LEVELS.has('info'));
      assert.ok(VALID_LOG_LEVELS.has('http'));
      assert.ok(VALID_LOG_LEVELS.has('debug'));
    });

    void it('should normalize uppercase log levels and fall back safely', () => {
      assert.equal(resolveLogLevel('INFO'), 'info');
      assert.equal(resolveLogLevel('DEBUG'), 'debug');
      assert.equal(resolveLogLevel('WARN'), 'warn');
      assert.equal(resolveLogLevel('ERROR'), 'error');
      assert.equal(resolveLogLevel('HTTP'), 'http');
      assert.equal(resolveLogLevel('  info  '), 'info');
      assert.equal(resolveLogLevel('verbose'), 'info');
      assert.equal(resolveLogLevel('unknown'), 'info');
      assert.equal(resolveLogLevel(undefined), 'info');
    });

    void it('should accurately identify Error objects vs plain metadata', () => {
      assert.equal(isErrorObject(new Error('test')), true);
      assert.equal(
        isErrorObject({
          name: 'CustomError',
          message: 'failed',
          stack: 'CustomError: failed\n    at test.ts:1:1',
        }),
        true,
      );
      assert.equal(isErrorObject({ name: 'bucket-x', message: 'extra', stack: 'abc' }), false);
      assert.equal(isErrorObject('string error'), false);
      assert.equal(isErrorObject(null), false);
      assert.equal(isErrorObject(undefined), false);
    });

    void it('should accurately identify potential error payloads with isPotentialError', () => {
      assert.equal(isPotentialError(new Error('fail')), true);
      assert.equal(isPotentialError('non-empty string error'), true);
      assert.equal(isPotentialError({ code: 500 }), true);
      assert.equal(isPotentialError(null), false);
      assert.equal(isPotentialError(undefined), false);
      assert.equal(isPotentialError(false), false);
      assert.equal(isPotentialError(0), false);
      assert.equal(isPotentialError(''), false);
      assert.equal(isPotentialError([]), false);
    });

    void it('should sanitize error messages and handle circular references with sanitizeErrorMessage', () => {
      assert.equal(sanitizeErrorMessage('plain message'), 'plain message');
      assert.equal(sanitizeErrorMessage(404), '404');
      assert.equal(sanitizeErrorMessage(new Error('error instance msg')), 'error instance msg');

      const circularObj: Record<string, unknown> = { message: 'initial' };
      circularObj['self'] = circularObj;
      assert.equal(sanitizeErrorMessage(circularObj), 'initial');
    });

    void it('should sanitize function values to null with sanitizeErrorMessage', () => {
      assert.equal(
        sanitizeErrorMessage(() => 1),
        'null',
      );
      function secretFn() {
        return 'SECRET_TOKEN';
      }
      assert.equal(sanitizeErrorMessage(secretFn), 'null');
    });

    void it('should wrap minimal server logger and handle level delegation via toAppLogger', () => {
      const logs: { level: string; msg: string; meta?: unknown }[] = [];
      const minimal = {
        info: (msg: string, meta?: unknown) => logs.push({ level: 'info', msg, meta }),
        error: (msg: string, meta?: unknown) => logs.push({ level: 'error', msg, meta }),
      };

      const adapted = toAppLogger(minimal);
      adapted.info('Info message');
      adapted.error('Error message', new Error('err'));
      adapted.warn('Warn message');
      adapted.debug('Debug message'); // dropped on minimal logger without debug
      adapted.http('HTTP message'); // dropped on minimal logger without http

      assert.equal(logs.length, 3);
      assert.equal(logs[0]?.level, 'info');
      assert.equal(logs[0]?.msg, 'Info message');
      assert.equal(logs[1]?.level, 'error');
      assert.equal(logs[1]?.msg, 'Error message');
      assert.equal(logs[2]?.level, 'info'); // warn falls back to info on minimal logger
      assert.equal(logs[2]?.msg, '[WARN] Warn message');

      // Passing existing AppLogger returns it unchanged
      assert.equal(toAppLogger(adapted), adapted);
    });
  });

  void describe('formatErrorDetail utility', () => {
    void it('should format standard and named errors with Name: Message', () => {
      const err = new Error('Database connection failed');
      assert.equal(formatErrorDetail(err), 'Error: Database connection failed');

      const customErr = new Error('Storage backend unreachable');
      customErr.name = 'StorageBackendError';
      assert.equal(
        formatErrorDetail(customErr),
        'StorageBackendError: Storage backend unreachable',
      );
    });

    void it('should format enumerable error properties in error detail', () => {
      const gcsErr = new Error('Object not found');
      gcsErr.name = 'ApiError';
      (gcsErr as unknown as Record<string, unknown>)['code'] = 404;
      (gcsErr as unknown as Record<string, unknown>)['statusCode'] = 404;

      const detail = formatErrorDetail(gcsErr);
      assert.ok(detail.startsWith('ApiError: Object not found'));
      assert.ok(detail.includes('code: 404'));
      assert.ok(detail.includes('statusCode: 404'));
    });

    void it('should format object, string, and unknown errors gracefully', () => {
      assert.equal(formatErrorDetail({ name: 'CustomErr', message: 'Fail' }), 'CustomErr: Fail');
      assert.equal(formatErrorDetail('raw error string'), 'Error: raw error string');
      assert.equal(formatErrorDetail(404), 'Error: 404');
    });
  });

  void describe('sanitizeAllErrorsInValue utility', () => {
    void it('should preserve primitives and sanitize errors', () => {
      assert.equal(sanitizeAllErrorsInValue('test'), 'test');
      assert.equal(sanitizeAllErrorsInValue(123), 123);
      assert.equal(sanitizeAllErrorsInValue(true), true);
      assert.equal(sanitizeAllErrorsInValue(null), null);
      assert.equal(sanitizeAllErrorsInValue(undefined), undefined);
      assert.equal(sanitizeAllErrorsInValue(10n), '10');
      const err = new Error('boom');
      assert.deepEqual(sanitizeAllErrorsInValue(err), { name: 'Error', message: 'boom' });
    });

    void it('should serialize functions and function properties to null without leaking code', () => {
      assert.equal(
        sanitizeAllErrorsInValue(() => 1),
        'null',
      );
      function secretFn() {
        return 'SECRET_KEY';
      }
      assert.equal(sanitizeAllErrorsInValue(secretFn), 'null');
      assert.deepEqual(sanitizeAllErrorsInValue({ handler: secretFn }), { handler: 'null' });
      assert.deepEqual(sanitizeAllErrorsInValue({ nested: { fn: () => 1 } }), {
        nested: { fn: 'null' },
      });
      assert.deepEqual(sanitizeAllErrorsInValue([secretFn]), ['null']);
    });
  });

  void describe('formatJavaStyleStackTrace and Cause Chains', () => {
    void it('should format a standard Error with complete stack trace', () => {
      const err = new Error('Sample operation failed');
      const trace = formatJavaStyleStackTrace(err);

      assert.ok(trace.startsWith('Error: Sample operation failed'));
      assert.ok(trace.includes('at '));
    });

    void it('should format single-level nested cause chain (ES2022 Error.cause)', () => {
      const rootCause = new Error('connect ECONNREFUSED 127.0.0.1:443');
      rootCause.name = 'FetchError';

      const topError = new Error('Connection refused to Google Cloud Storage', {
        cause: rootCause,
      });
      topError.name = 'StorageBackendError';

      const trace = formatJavaStyleStackTrace(topError);

      assert.ok(
        trace.startsWith('StorageBackendError: Connection refused to Google Cloud Storage'),
      );
      assert.ok(trace.includes('Caused by: FetchError: connect ECONNREFUSED 127.0.0.1:443'));
      assert.ok(trace.indexOf('StorageBackendError:') < trace.indexOf('Caused by: FetchError:'));
    });

    void it('should format multi-level nested cause chains in Java order (top down)', () => {
      const level1 = new Error('Low level disk error');
      level1.name = 'DiskError';

      const level2 = new Error('Failed to read config file', { cause: level1 });
      level2.name = 'ConfigReadError';

      const level3 = new Error('Application bootstrap failed', { cause: level2 });
      level3.name = 'BootstrapError';

      const trace = formatJavaStyleStackTrace(level3);

      assert.ok(trace.includes('BootstrapError: Application bootstrap failed'));
      assert.ok(trace.includes('Caused by: ConfigReadError: Failed to read config file'));
      assert.ok(trace.includes('Caused by: DiskError: Low level disk error'));

      const posBootstrap = trace.indexOf('BootstrapError:');
      const posConfig = trace.indexOf('Caused by: ConfigReadError:');
      const posDisk = trace.indexOf('Caused by: DiskError:');

      assert.ok(posBootstrap < posConfig);
      assert.ok(posConfig < posDisk);
    });

    void it('should handle direct circular cause (err.cause = err) without infinite loop', () => {
      const circularError = new Error('Direct circular error');
      (circularError as { cause: unknown }).cause = circularError;

      const trace = formatJavaStyleStackTrace(circularError);

      assert.ok(trace.includes('Error: Direct circular error'));
      assert.ok(trace.includes('Caused by: [Circular: Direct circular error]'));
    });

    void it('should handle indirect circular cause (A -> B -> A) without infinite loop', () => {
      const errA = new Error('Error A');
      const errB = new Error('Error B', { cause: errA });
      (errA as { cause: unknown }).cause = errB;

      const trace = formatJavaStyleStackTrace(errB);

      assert.ok(trace.includes('Error: Error B'));
      assert.ok(trace.includes('Caused by: Error: Error A'));
      assert.ok(trace.includes('Caused by: [Circular: Error B]'));
    });

    void it('should handle null, undefined, strings, and non-error objects gracefully', () => {
      assert.equal(formatJavaStyleStackTrace(null), 'Error: Unknown error');
      assert.equal(formatJavaStyleStackTrace(undefined), 'Error: Unknown error');
      assert.equal(formatJavaStyleStackTrace('plain error message'), 'Error: plain error message');

      const nonErrorObj = { name: 'CustomObjError', message: 'Something went wrong' };
      assert.equal(formatJavaStyleStackTrace(nonErrorObj), 'CustomObjError: Something went wrong');
    });

    void it('should format errors when error.stack is missing or stripped', () => {
      const errWithoutStack = new Error('No stack available');
      delete (errWithoutStack as { stack?: unknown }).stack;

      const trace = formatJavaStyleStackTrace(errWithoutStack);
      assert.equal(trace, 'Error: No stack available');

      const errEmptyStack = new Error('Empty stack property');
      errEmptyStack.stack = '';
      assert.equal(formatJavaStyleStackTrace(errEmptyStack), 'Error: Empty stack property');
    });

    void it('should format primitive error causes such as string, number, or boolean', () => {
      const errWithStringCause = new Error('High level failure', {
        cause: 'Network connection aborted by peer',
      });
      const traceString = formatJavaStyleStackTrace(errWithStringCause);
      assert.ok(traceString.includes('Error: High level failure'));
      assert.ok(traceString.includes('Caused by: Error: Network connection aborted by peer'));

      const errWithNumCause = new Error('Failed with status code', { cause: 504 });
      const traceNum = formatJavaStyleStackTrace(errWithNumCause);
      assert.ok(traceNum.includes('Error: Failed with status code'));
      assert.ok(traceNum.includes('Caused by: Error: 504'));
    });

    void it('should format plain object causes with message or diagnostic properties', () => {
      const plainObjCause = {
        name: 'DatabaseError',
        message: 'Query timed out after 5000ms',
        code: 'ETIMEDOUT',
      };
      const topError = new Error('Service unavailable', { cause: plainObjCause });
      const trace = formatJavaStyleStackTrace(topError);
      assert.ok(trace.includes('Error: Service unavailable'));
      assert.ok(trace.includes('Caused by: DatabaseError: Query timed out after 5000ms'));
    });

    void it('should format 4-level deep nested cause chains accurately', () => {
      const err0 = new Error('Root OS socket failure');
      err0.name = 'SocketError';
      const err1 = new Error('HTTP client request failed', { cause: err0 });
      err1.name = 'HttpClientError';
      const err2 = new Error('GCS stream read failure', { cause: err1 });
      err2.name = 'StorageStreamError';
      const err3 = new Error('Asset streaming endpoint failed', { cause: err2 });
      err3.name = 'RouterError';

      const trace = formatJavaStyleStackTrace(err3);
      assert.ok(trace.includes('RouterError: Asset streaming endpoint failed'));
      assert.ok(trace.includes('Caused by: StorageStreamError: GCS stream read failure'));
      assert.ok(trace.includes('Caused by: HttpClientError: HTTP client request failed'));
      assert.ok(trace.includes('Caused by: SocketError: Root OS socket failure'));

      const p3 = trace.indexOf('RouterError:');
      const p2 = trace.indexOf('Caused by: StorageStreamError:');
      const p1 = trace.indexOf('Caused by: HttpClientError:');
      const p0 = trace.indexOf('Caused by: SocketError:');
      assert.ok(p3 < p2 && p2 < p1 && p1 < p0);
    });

    void it('should capture and format un-truncated stack traces with more than 10 frames', () => {
      function recursiveFrame(currentDepth: number, maxDepth: number): Error {
        if (currentDepth >= maxDepth) {
          return new Error('Deeply nested stack execution failure');
        }
        return recursiveFrame(currentDepth + 1, maxDepth);
      }

      const deepError = recursiveFrame(1, 30);
      const trace = formatJavaStyleStackTrace(deepError);
      const frameLines = trace.split(/\r?\n/).filter((line) => /^\s+at\s+/.test(line));

      assert.ok(
        frameLines.length > 10,
        `Expected more than default 10 V8 stack frames, but received ${String(frameLines.length)}`,
      );
      assert.ok(
        frameLines.length >= 30,
        `Expected at least 30 stack frames, but received ${String(frameLines.length)}`,
      );
    });
  });

  void describe('Winston formatters (formatDecision, formatJavaStyleError, formatConsoleOutput)', () => {
    void it('should populate decision properties and format message in formatDecision', () => {
      const info = {
        [DECISION_SYMBOL]: true,
        level: 'info',
        action: 'Router',
        choice: 'SPA fallback (index.html)',
        reason: 'Path has no static extension',
      };

      const formatted = formatDecision().transform(info);
      assert.ok(typeof formatted === 'object');
      assert.equal(
        formatted.message,
        'Decision [Router] | Choice: SPA fallback (index.html) | Reason: Path has no static extension',
      );
    });

    void it('should not mark plain objects with action/choice/reason as decisions unless DECISION_SYMBOL is set', () => {
      const info = {
        level: 'info',
        message: 'Original message',
        action: 'Router',
        choice: 'SPA fallback',
        reason: 'Path match',
      };

      const formatted = formatDecision().transform(info);
      assert.ok(typeof formatted === 'object');
      assert.equal(formatted.message, 'Original message');
    });

    void it('should extract error and populate errorDetail and callStack in formatJavaStyleError', () => {
      const err = new Error('Simulated failure');
      const info = {
        level: 'error',
        message: 'Request failed',
        error: err,
      };

      const formatted = formatJavaStyleError().transform(info);
      assert.ok(typeof formatted === 'object');
      assert.equal(formatted['errorDetail'], 'Error: Simulated failure');
      assert.ok(typeof formatted['callStack'] === 'string');
      assert.ok(formatted['callStack'].includes('Error: Simulated failure'));
    });

    void it('should format bounded error details without leaking sensitive auth or bulky response/config objects', () => {
      const gcsErr = new Error('Access denied to GCS bucket');
      gcsErr.name = 'ApiError';
      (gcsErr as unknown as Record<string, unknown>)['code'] = 403;
      (gcsErr as unknown as Record<string, unknown>)['statusCode'] = 403;
      (gcsErr as unknown as Record<string, unknown>)['response'] = {
        data: 'forbidden',
        headers: { authorization: 'Bearer secret-jwt-token' },
      };
      (gcsErr as unknown as Record<string, unknown>)['config'] = {
        headers: { authorization: 'Bearer secret-jwt-token' },
      };

      const detail = formatErrorDetail(gcsErr);
      assert.ok(detail.startsWith('ApiError: Access denied to GCS bucket'));
      assert.ok(detail.includes('code: 403'));
      assert.ok(detail.includes('statusCode: 403'));
      assert.ok(!detail.includes('secret-jwt-token'));
      assert.ok(!detail.includes('response:'));
      assert.ok(!detail.includes('config:'));
    });

    void it('should omit camelCase secret fields such as apiKey and accessToken from error detail', () => {
      const gcsErr = new Error('Forbidden');
      gcsErr.name = 'ApiError';
      (gcsErr as unknown as Record<string, unknown>)['code'] = 403;
      (gcsErr as unknown as Record<string, unknown>)['apiKey'] = 'AIzaSECRET';
      (gcsErr as unknown as Record<string, unknown>)['accessToken'] = 'ya29.SECRET';
      (gcsErr as unknown as Record<string, unknown>)['clientSecret'] = 'client-secret-value';
      (gcsErr as unknown as Record<string, unknown>)['privateKey'] = '-----BEGIN PRIVATE KEY-----';
      (gcsErr as unknown as Record<string, unknown>)['refreshToken'] = 'refresh-secret';

      const detail = formatErrorDetail(gcsErr);
      assert.ok(detail.startsWith('ApiError: Forbidden'));
      assert.ok(detail.includes('code: 403'));
      assert.ok(!detail.includes('AIzaSECRET'));
      assert.ok(!detail.includes('ya29.SECRET'));
      assert.ok(!detail.includes('client-secret-value'));
      assert.ok(!detail.includes('BEGIN PRIVATE KEY'));
      assert.ok(!detail.includes('refresh-secret'));
      assert.ok(!detail.includes('apiKey'));
      assert.ok(!detail.includes('accessToken'));
      assert.ok(!detail.includes('clientSecret'));
      assert.ok(!detail.includes('privateKey'));
      assert.ok(!detail.includes('refreshToken'));
    });

    void it('should format console output with Error Detail before Call Stack', () => {
      const { appLogger, stream } = createMemoryLogger();

      const rootErr = new Error('Remote connection timeout');
      rootErr.name = 'TimeoutError';
      const storageErr = new Error('Failed to fetch GCS object', { cause: rootErr });
      storageErr.name = 'StorageBackendError';
      (storageErr as unknown as Record<string, unknown>)['code'] = 503;

      appLogger.error('Failed to stream asset', storageErr, {
        path: '/assets/bundle.js',
        status: 502,
      });

      const output = stream.output;

      assert.ok(output.includes('[error]: Failed to stream asset'));
      assert.ok(output.includes('Path: /assets/bundle.js'));
      assert.ok(output.includes('Status: 502'));
      assert.ok(
        output.includes(
          'Error Detail: StorageBackendError: Failed to fetch GCS object (code: 503)',
        ),
      );
      assert.ok(output.includes('Call Stack:'));
      assert.ok(output.includes('StorageBackendError: Failed to fetch GCS object'));
      assert.ok(output.includes('Caused by: TimeoutError: Remote connection timeout'));

      const detailIndex = output.indexOf('Error Detail:');
      const callStackIndex = output.indexOf('Call Stack:');
      assert.ok(detailIndex > 0);
      assert.ok(callStackIndex > detailIndex, 'Error Detail must precede Call Stack');
    });

    void it('should format console lines directly using formatConsoleOutput', () => {
      const info = {
        level: 'info',
        message: 'Direct printf test',
        timestamp: '2026-10-08T00:00:00.000Z',
        customKey: 'customVal',
      };

      const transformed = formatConsoleOutput.transform(info);
      assert.ok(typeof transformed === 'object');
      const formattedMessage = (transformed as unknown as Record<symbol, string>)[
        Symbol.for('message')
      ];
      assert.ok(typeof formattedMessage === 'string');
      assert.ok(formattedMessage.includes('2026-10-08T00:00:00.000Z [info]: Direct printf test'));
      assert.ok(formattedMessage.includes('CustomKey: customVal'));
    });
  });

  void describe('AppLogger & WinstonAppLogger API', () => {
    void it('should log info, warn, error, http, and debug messages with metadata', () => {
      const { appLogger, stream } = createMemoryLogger({ level: 'debug' });

      appLogger.info('Server initialized', { port: 8080 });
      appLogger.http('Incoming HTTP GET /health', { method: 'GET', url: '/health' });
      appLogger.debug('Memory cache hit', { key: 'index.html' });
      appLogger.warn('High memory usage detected', { heapUsedMb: 450 });

      const output = stream.output;
      assert.ok(output.includes('[info]: Server initialized | Port: 8080'));
      assert.ok(output.includes('[http]: Incoming HTTP GET /health | Method: GET | Url: /health'));
      assert.ok(output.includes('[debug]: Memory cache hit | Key: index.html'));
      assert.ok(output.includes('[warn]: High memory usage detected | HeapUsedMb: 450'));
    });

    void it('should extract top-level error and cause chains across info, http, and debug levels', () => {
      const { appLogger, stream } = createMemoryLogger({ level: 'debug' });

      const rootErr = new Error('ECONNREFUSED 127.0.0.1:443');
      rootErr.name = 'FetchError';
      const topErr = new Error('Connection refused to GCS', { cause: rootErr });
      topErr.name = 'StorageBackendError';
      (topErr as unknown as Record<string, unknown>)['code'] = 503;

      appLogger.info('info with err', topErr);
      assert.ok(stream.output.includes('[info]: info with err'));
      assert.ok(
        stream.output.includes(
          'Error Detail: StorageBackendError: Connection refused to GCS (code: 503)',
        ),
      );
      assert.ok(stream.output.includes('Caused by: FetchError: ECONNREFUSED 127.0.0.1:443'));

      stream.clear();
      appLogger.debug('debug with err', topErr);
      assert.ok(stream.output.includes('[debug]: debug with err'));
      assert.ok(
        stream.output.includes('Error Detail: StorageBackendError: Connection refused to GCS'),
      );

      stream.clear();
      appLogger.http('http with err', topErr);
      assert.ok(stream.output.includes('[http]: http with err'));
      assert.ok(
        stream.output.includes('Error Detail: StorageBackendError: Connection refused to GCS'),
      );
    });

    void it('should extract error from later meta slots (e.g. error(msg, meta, err))', () => {
      const { appLogger, stream } = createMemoryLogger();

      const topErr = new Error('Backend failed');
      topErr.name = 'StorageBackendError';
      (topErr as unknown as Record<string, unknown>)['code'] = 503;

      appLogger.error('Failed', { status: 502 }, topErr);

      const output = stream.output;
      assert.ok(output.includes('[error]: Failed | Status: 502'));
      assert.ok(output.includes('Error Detail: StorageBackendError: Backend failed (code: 503)'));
      assert.ok(output.includes('Call Stack:\nStorageBackendError: Backend failed'));
    });

    void it('should treat positional primitives as context metadata rather than fake exceptions', () => {
      const { appLogger, stream } = createMemoryLogger();

      appLogger.warn('Retrying connection', 'attempt 3');
      assert.ok(stream.output.includes('[warn]: Retrying connection | Meta: attempt 3'));
      assert.ok(!stream.output.includes('Error Detail:'));
      assert.ok(!stream.output.includes('Call Stack:'));

      stream.clear();
      appLogger.warn('Retry count', 3);
      assert.ok(stream.output.includes('[warn]: Retry count | Meta: 3'));
      assert.ok(!stream.output.includes('Error Detail:'));
      assert.ok(!stream.output.includes('Call Stack:'));

      stream.clear();
      appLogger.error('Multiple positional values', 'value1', 'value2');
      assert.ok(
        stream.output.includes('[error]: Multiple positional values | Meta: ["value1","value2"]'),
      );
      assert.ok(!stream.output.includes('Error Detail:'));
      assert.ok(!stream.output.includes('Call Stack:'));
    });

    void it('should handle explicit { error: primitive } fallback', () => {
      const { appLogger, stream } = createMemoryLogger();

      appLogger.error('failed operation', { error: 'explicit primitive error', status: 500 });
      assert.ok(stream.output.includes('[error]: failed operation | Status: 500'));
      assert.ok(stream.output.includes('Error Detail: Error: explicit primitive error'));
      assert.ok(stream.output.includes('Call Stack:\nError: explicit primitive error'));
    });

    void it('should preserve ordinary metadata containing name, message, stack without treating as Error', () => {
      const { appLogger, stream } = createMemoryLogger();

      appLogger.info('Processing bucket', { name: 'bucket-x', message: 'extra', stack: 'abc' });

      const output = stream.output;
      assert.ok(output.includes('[info]: Processing bucket'));
      assert.ok(!output.includes('Processing bucket extra'));
      assert.ok(output.includes('Message: extra'));
      assert.ok(output.includes('Name: bucket-x'));
      assert.ok(output.includes('Stack: abc'));
      assert.ok(!output.includes('Error Detail:'));
      assert.ok(!output.includes('Call Stack:'));
    });

    void it('should not corrupt decision message when payload contains user message property', () => {
      const { appLogger, stream } = createMemoryLogger();

      appLogger.decision({
        action: 'Config',
        choice: 'port: 8080',
        reason: 'default fallback',
        message: 'custom user message',
      });

      const output = stream.output;
      assert.ok(
        output.includes('Decision [Config] | Choice: port: 8080 | Reason: default fallback'),
      );
      assert.ok(!output.includes('Reason: default fallback custom user message'));
      assert.ok(output.includes('Message: custom user message'));
    });

    void it('should preserve action, choice, and reason metadata on non-decision logs', () => {
      const { appLogger, stream } = createMemoryLogger();

      appLogger.error(
        'Request failed',
        { action: 'Router', choice: 'x', reason: 'y', url: '/a' },
        new Error('real error'),
      );

      const output = stream.output;
      assert.ok(output.includes('[error]: Request failed'));
      assert.ok(output.includes('Action: Router'));
      assert.ok(output.includes('Choice: x'));
      assert.ok(output.includes('Reason: y'));
      assert.ok(output.includes('Url: /a'));
      assert.ok(output.includes('Error Detail: Error: real error'));
      assert.ok(output.includes('Call Stack:\nError: real error'));
    });

    void it('should not classify plain objects with stack-like properties as Errors unless valid stack frame is present', () => {
      const { appLogger, stream } = createMemoryLogger();

      assert.equal(isErrorObject({ stack: 'located at home' }), false);
      assert.equal(isErrorObject({ stack: 'us-central1' }), false);
      assert.equal(
        isErrorObject({
          name: 'CustomError',
          message: 'boom',
          stack: 'CustomError: boom\n    at Object.<anonymous> (/app/test.ts:1:1)',
        }),
        true,
      );

      appLogger.info('Object with non-trace stack', { stack: 'located at home' });
      assert.ok(
        stream.output.includes('[info]: Object with non-trace stack | Stack: located at home'),
      );
      assert.ok(!stream.output.includes('Error Detail:'));
      assert.ok(!stream.output.includes('Call Stack:'));
    });

    void it('should preserve user error string context when a real Error instance is also supplied', () => {
      const { appLogger, stream } = createMemoryLogger();

      appLogger.error(
        'dual error test',
        { error: 'user-ctx', status: 500 },
        new Error('real error'),
      );

      const output = stream.output;
      assert.ok(output.includes('[error]: dual error test'));
      assert.ok(output.includes('ErrorContext: user-ctx'));
      assert.ok(output.includes('Status: 500'));
      assert.ok(output.includes('Error Detail: Error: real error'));
      assert.ok(output.includes('Call Stack:\nError: real error'));
    });

    void it('should log operational decisions via decision method and logDecision helper', () => {
      const { appLogger, stream } = createMemoryLogger();

      const payload: DecisionLogPayload = {
        action: 'CachePolicy',
        choice: 'immutable (31536000s)',
        reason: "Asset 'main-5T7P2N6K.js' matched content-hashed filename pattern",
        file: 'main-5T7P2N6K.js',
      };

      appLogger.decision(payload);
      assert.ok(stream.output.includes('Decision [CachePolicy]'));
      assert.ok(stream.output.includes('Choice: immutable (31536000s)'));
      assert.ok(
        stream.output.includes(
          "Reason: Asset 'main-5T7P2N6K.js' matched content-hashed filename pattern",
        ),
      );
      assert.ok(stream.output.includes('File: main-5T7P2N6K.js'));

      stream.clear();

      logDecision(appLogger, {
        action: 'Sanitizer',
        choice: 'reject request (400)',
        reason: 'Directory traversal sequence detected in URL path',
      });

      assert.ok(stream.output.includes('Decision [Sanitizer]'));
      assert.ok(stream.output.includes('Choice: reject request (400)'));
      assert.ok(
        stream.output.includes('Reason: Directory traversal sequence detected in URL path'),
      );
    });

    void it('should not treat decision error string metadata as exception trace', () => {
      const { appLogger, stream } = createMemoryLogger();

      appLogger.decision({
        action: 'Storage',
        choice: '404 Not Found',
        reason: 'Object does not exist',
        error: 'not-an-exception',
      });

      const output = stream.output;
      assert.ok(
        output.includes(
          'Decision [Storage] | Choice: 404 Not Found | Reason: Object does not exist',
        ),
      );
      assert.ok(output.includes('Error: not-an-exception'));
      assert.ok(!output.includes('Error Detail:'));
      assert.ok(!output.includes('Call Stack:'));
    });

    void it('should support passing Error directly to error() or warn()', () => {
      const { appLogger, stream } = createMemoryLogger();

      const directErr = new Error('Direct error argument');
      appLogger.error(directErr);

      assert.ok(stream.output.includes('[error]: Direct error argument'));
      assert.ok(stream.output.includes('Error Detail: Error: Direct error argument'));
      assert.ok(stream.output.includes('Call Stack:\nError: Direct error argument'));

      stream.clear();

      const directWarn = new Error('Direct warning argument');
      appLogger.warn(directWarn);
      assert.ok(stream.output.includes('[warn]: Direct warning argument'));
      assert.ok(stream.output.includes('Error Detail: Error: Direct warning argument'));
    });

    void it('should filter log emissions according to configured log level', () => {
      const { appLogger, stream } = createMemoryLogger({ level: 'warn' });

      appLogger.debug('Debug message');
      appLogger.info('Info message');
      assert.equal(stream.output, '');

      appLogger.warn('Warning message');
      assert.ok(stream.output.includes('[warn]: Warning message'));

      stream.clear();
      appLogger.error('Error message');
      assert.ok(stream.output.includes('[error]: Error message'));
    });

    void it('should format output as JSON when json: true is specified', () => {
      const { appLogger, stream } = createMemoryLogger({ json: true });

      const err = new Error('JSON mode failure');
      appLogger.error('Encountered an issue', err, { code: 500 });

      const line = stream.output.trim();
      const parsed = JSON.parse(line) as Record<string, unknown>;

      assert.equal(parsed['level'], 'error');
      assert.equal(parsed['message'], 'Encountered an issue');
      assert.equal(parsed['code'], 500);
      assert.equal(parsed['errorDetail'], 'Error: JSON mode failure');
      assert.ok(
        typeof parsed['callStack'] === 'string' &&
          parsed['callStack'].includes('Error: JSON mode failure'),
      );
      const jsonError = parsed['error'] as Record<string, unknown>;
      assert.equal(jsonError['name'], 'Error');
      assert.equal(jsonError['message'], 'JSON mode failure');
      assert.equal(jsonError['stack'], undefined);
    });

    void it('should not leak nested Authorization, apiKey, or accessToken values in JSON error output', () => {
      const { appLogger, stream } = createMemoryLogger({ json: true });

      const gcsErr = new Error('Forbidden');
      gcsErr.name = 'ApiError';
      (gcsErr as unknown as Record<string, unknown>)['code'] = 403;
      (gcsErr as unknown as Record<string, unknown>)['apiKey'] = 'AIzaSECRET';
      (gcsErr as unknown as Record<string, unknown>)['accessToken'] = 'ya29.SECRET';
      (gcsErr as unknown as Record<string, unknown>)['response'] = {
        config: {
          headers: {
            Authorization: 'Bearer ya29.LEAK',
          },
        },
      };

      appLogger.error('GCS request failed', gcsErr);

      const output = stream.output;
      assert.ok(!output.includes('ya29.LEAK'));
      assert.ok(!output.includes('AIzaSECRET'));
      assert.ok(!output.includes('ya29.SECRET'));
      assert.ok(!output.includes('Authorization'));
      assert.ok(!output.includes('apiKey'));
      assert.ok(!output.includes('accessToken'));

      const parsed = JSON.parse(output.trim()) as Record<string, unknown>;
      assert.equal(parsed['errorDetail'], 'ApiError: Forbidden (code: 403)');
      assert.ok(typeof parsed['callStack'] === 'string');
      const jsonError = parsed['error'] as Record<string, unknown>;
      assert.equal(jsonError['name'], 'ApiError');
      assert.equal(jsonError['message'], 'Forbidden');
      assert.equal(jsonError['code'], 403);
      assert.equal(jsonError['apiKey'], undefined);
      assert.equal(jsonError['accessToken'], undefined);
      assert.equal(jsonError['response'], undefined);
    });

    void it('should mark JSON decision records with an unspoofable logType field', () => {
      const { appLogger, stream } = createMemoryLogger({ json: true });

      appLogger.decision({
        action: 'Router',
        choice: 'SPA fallback (index.html)',
        reason: 'Path has no static extension',
        logType: 'spoofed',
        path: '/profile',
      });

      const parsed = JSON.parse(stream.output.trim()) as Record<string, unknown>;
      assert.equal(parsed['logType'], DECISION_LOG_TYPE);
      assert.equal(parsed['action'], 'Router');
      assert.equal(parsed['choice'], 'SPA fallback (index.html)');
      assert.equal(parsed['reason'], 'Path has no static extension');
      assert.equal(parsed['path'], '/profile');
      assert.ok(
        typeof parsed['message'] === 'string' && parsed['message'].startsWith('Decision [Router]'),
      );

      stream.clear();
      appLogger.info('ordinary log', {
        action: 'Router',
        choice: 'x',
        reason: 'y',
        logType: 'decision',
      });
      const ordinary = JSON.parse(stream.output.trim()) as Record<string, unknown>;
      assert.equal(ordinary['logType'], undefined);
      assert.equal(ordinary['action'], 'Router');
      assert.equal(ordinary['choice'], 'x');
      assert.equal(ordinary['reason'], 'y');
    });

    void it('should hide logType in console decision output while preserving Error Detail then Call Stack order', () => {
      const { appLogger, stream } = createMemoryLogger();

      appLogger.decision({
        action: 'Config',
        choice: 'port: 8080',
        reason: 'PORT environment variable not set, falling back to DEFAULT_PORT',
      });

      const decisionOutput = stream.output;
      assert.ok(
        decisionOutput.includes(
          'Decision [Config] | Choice: port: 8080 | Reason: PORT environment variable not set, falling back to DEFAULT_PORT',
        ),
      );
      assert.ok(!decisionOutput.includes('LogType:'));
      assert.ok(!decisionOutput.includes('logType'));

      stream.clear();
      const err = new Error('stream failed');
      err.name = 'StorageBackendError';
      appLogger.error('Failed to stream asset', err, { path: '/assets/bundle.js', status: 502 });
      const errorOutput = stream.output;
      const summaryIndex = errorOutput.indexOf('[error]: Failed to stream asset');
      const detailIndex = errorOutput.indexOf('Error Detail:');
      const callStackIndex = errorOutput.indexOf('Call Stack:');
      assert.ok(summaryIndex >= 0);
      assert.ok(detailIndex > summaryIndex);
      assert.ok(callStackIndex > detailIndex);
    });

    void it('should handle circular error causes cleanly in JSON mode', () => {
      const { appLogger, stream } = createMemoryLogger({ json: true });

      const circA = new Error('Circular error A');
      const circB = new Error('Circular error B', { cause: circA });
      (circA as { cause: unknown }).cause = circB;

      appLogger.error('Circular JSON failure', circB);

      const line = stream.output.trim();
      const parsed = JSON.parse(line) as Record<string, unknown>;

      assert.equal(parsed['level'], 'error');
      assert.ok(
        typeof parsed['callStack'] === 'string' &&
          parsed['callStack'].includes('Caused by: [Circular: Circular error B]'),
      );
    });

    void it('should suppress all output when silent: true is configured', () => {
      const { appLogger, stream } = createMemoryLogger({ silent: true });

      appLogger.info('Silent info');
      appLogger.error('Silent error', new Error('Should not log'));
      appLogger.decision({ action: 'SilentAction', choice: 'None', reason: 'Silent test' });

      assert.equal(stream.output, '');
    });

    void it('should expose the underlying Winston instance via getter', () => {
      const { appLogger } = createMemoryLogger();
      assert.ok(appLogger instanceof WinstonAppLogger);
      assert.equal(typeof appLogger.winston, 'object');
    });

    void it('should export a functional default singleton logger', () => {
      assert.equal(typeof logger, 'object');
      assert.equal(typeof logger.info, 'function');
      assert.equal(typeof logger.warn, 'function');
      assert.equal(typeof logger.error, 'function');
      assert.equal(typeof logger.http, 'function');
      assert.equal(typeof logger.debug, 'function');
      assert.equal(typeof logger.decision, 'function');
    });

    void it('should not leak secondary Error credentials and should preserve both stacks in console and JSON modes', () => {
      const firstErr = new Error('Primary error failure');
      firstErr.name = 'PrimaryError';

      const secondaryErr = new Error('Secondary API connection refused');
      secondaryErr.name = 'ApiError';
      (secondaryErr as unknown as Record<string, unknown>)['code'] = 503;
      (secondaryErr as unknown as Record<string, unknown>)['apiKey'] = 'LEAK_API_KEY_123';
      (secondaryErr as unknown as Record<string, unknown>)['response'] = {
        config: {
          headers: {
            Authorization: 'Bearer LEAK_TOKEN_456',
          },
        },
      };

      // Console mode verification
      const consoleLogger = createMemoryLogger();
      consoleLogger.appLogger.error('Dual error occurrence', firstErr, secondaryErr);
      const consoleOutput = consoleLogger.stream.output;

      assert.ok(!consoleOutput.includes('LEAK_API_KEY_123'));
      assert.ok(!consoleOutput.includes('LEAK_TOKEN_456'));
      assert.ok(!consoleOutput.includes('Authorization'));
      assert.ok(!consoleOutput.includes('apiKey'));
      assert.ok(consoleOutput.includes('Error Detail: PrimaryError: Primary error failure'));
      assert.ok(consoleOutput.includes('PrimaryError: Primary error failure'));
      assert.ok(
        consoleOutput.includes('Additional Error:\nApiError: Secondary API connection refused'),
      );

      // JSON mode verification
      const jsonLogger = createMemoryLogger({ json: true });
      jsonLogger.appLogger.error('Dual error occurrence', firstErr, secondaryErr);
      const jsonOutput = jsonLogger.stream.output;

      assert.ok(!jsonOutput.includes('LEAK_API_KEY_123'));
      assert.ok(!jsonOutput.includes('LEAK_TOKEN_456'));
      assert.ok(!jsonOutput.includes('Authorization'));
      assert.ok(!jsonOutput.includes('apiKey'));

      const parsed = JSON.parse(jsonOutput.trim()) as Record<string, unknown>;
      assert.equal(parsed['errorDetail'], 'PrimaryError: Primary error failure');
      assert.ok(typeof parsed['callStack'] === 'string');
      assert.ok(parsed['callStack'].includes('PrimaryError: Primary error failure'));
      assert.ok(
        parsed['callStack'].includes(
          'Additional Error:\nApiError: Secondary API connection refused',
        ),
      );

      const additional = parsed['additionalErrors'] as Record<string, unknown>[];
      assert.ok(Array.isArray(additional) && additional.length === 1);
      assert.equal(additional[0]?.['name'], 'ApiError');
      assert.equal(additional[0]?.['message'], 'Secondary API connection refused');
      assert.equal(additional[0]?.['code'], 503);
      assert.equal(additional[0]?.['apiKey'], undefined);
      assert.equal(additional[0]?.['response'], undefined);
    });

    void it('should sanitize Error objects nested in metadata under arbitrary keys (details, cause, original, deeply nested)', () => {
      const nestedErr = new Error('Backend failed');
      nestedErr.name = 'BackendError';
      (nestedErr as unknown as Record<string, unknown>)['code'] = 'ECONNRESET';
      (nestedErr as unknown as Record<string, unknown>)['apiKey'] = 'SECRET_DETAILS_KEY';
      (nestedErr as unknown as Record<string, unknown>)['response'] = {
        config: {
          headers: {
            Authorization: 'Bearer SECRET_DETAILS_TOKEN',
          },
        },
      };

      const { appLogger, stream } = createMemoryLogger({ json: true });
      appLogger.error('Nested error in metadata', {
        details: nestedErr,
        original: nestedErr,
        deeply: {
          nested: nestedErr,
        },
        requestId: 'req-xyz-789',
        retryCount: 3,
      });

      const jsonOutput = stream.output;
      assert.ok(!jsonOutput.includes('SECRET_DETAILS_KEY'));
      assert.ok(!jsonOutput.includes('SECRET_DETAILS_TOKEN'));
      assert.ok(!jsonOutput.includes('Authorization'));
      assert.ok(!jsonOutput.includes('apiKey'));

      const parsed = JSON.parse(jsonOutput.trim()) as Record<string, unknown>;
      assert.equal(parsed['requestId'], 'req-xyz-789');
      assert.equal(parsed['retryCount'], 3);

      const details = parsed['details'] as Record<string, unknown>;
      assert.equal(details['name'], 'BackendError');
      assert.equal(details['message'], 'Backend failed');
      assert.equal(details['code'], 'ECONNRESET');
      assert.equal(details['apiKey'], undefined);

      const original = parsed['original'] as Record<string, unknown>;
      assert.equal(original['name'], 'BackendError');

      const deeply = parsed['deeply'] as Record<string, Record<string, unknown>>;
      assert.equal(deeply['nested']['name'], 'BackendError');
      assert.equal(deeply['nested']['apiKey'], undefined);
    });

    void it('should not leak secrets from plain-object error or cause in console or JSON mode', () => {
      // Plain-object error without string message
      const plainObjectErr = {
        response: {
          headers: {
            authorization: 'Bearer LEAK3_TOKEN',
          },
        },
      };

      const consoleLogger = createMemoryLogger();
      consoleLogger.appLogger.error('Plain object error test', { error: plainObjectErr });
      const consoleOutput = consoleLogger.stream.output;

      assert.ok(!consoleOutput.includes('LEAK3_TOKEN'));
      assert.ok(!consoleOutput.includes('Bearer'));
      assert.ok(consoleOutput.includes('Error Detail: Error: [object with keys: response]'));

      const jsonLogger = createMemoryLogger({ json: true });
      jsonLogger.appLogger.error('Plain object error test', { error: plainObjectErr });
      const jsonOutput = jsonLogger.stream.output;

      assert.ok(!jsonOutput.includes('LEAK3_TOKEN'));
      assert.ok(!jsonOutput.includes('Bearer'));
      const parsedJson = JSON.parse(jsonOutput.trim()) as Record<string, unknown>;
      assert.equal(parsedJson['errorDetail'], 'Error: [object with keys: response]');
      const parsedErr = parsedJson['error'] as Record<string, unknown>;
      assert.equal(parsedErr['name'], 'Error');
      assert.equal(parsedErr['message'], '[object with keys: response]');

      // Error with plain-object cause without string message
      const errWithPlainCause = new Error('High level error', {
        cause: {
          config: {
            token: 'LEAK4_CAUSE_TOKEN',
          },
        },
      });

      consoleLogger.stream.clear();
      consoleLogger.appLogger.error('Cause error test', errWithPlainCause);
      const causeConsoleOutput = consoleLogger.stream.output;

      assert.ok(!causeConsoleOutput.includes('LEAK4_CAUSE_TOKEN'));
      assert.ok(causeConsoleOutput.includes('Caused by: Error: [object with keys: config]'));

      jsonLogger.stream.clear();
      jsonLogger.appLogger.error('Cause error test', errWithPlainCause);
      const causeJsonOutput = jsonLogger.stream.output;

      assert.ok(!causeJsonOutput.includes('LEAK4_CAUSE_TOKEN'));
      const parsedCauseJson = JSON.parse(causeJsonOutput.trim()) as Record<string, unknown>;
      assert.ok(
        (parsedCauseJson['callStack'] as string).includes(
          'Caused by: Error: [object with keys: config]',
        ),
      );
    });

    void it('should not duplicate Error metadata on decision console lines when errorDetail is present', () => {
      const { appLogger, stream } = createMemoryLogger();
      const decisionErr = new Error('GCS bucket unreachable');
      decisionErr.name = 'StorageError';
      (decisionErr as unknown as Record<string, unknown>)['code'] = 502;

      appLogger.decision({
        action: 'Storage',
        choice: '502 Bad Gateway',
        reason: 'Storage backend error',
        error: decisionErr,
        bucket: 'my-bucket',
      });

      const output = stream.output;
      assert.ok(
        output.includes(
          'Decision [Storage] | Choice: 502 Bad Gateway | Reason: Storage backend error | Bucket: my-bucket',
        ),
      );
      assert.ok(output.includes('Error Detail: StorageError: GCS bucket unreachable (code: 502)'));
      assert.ok(output.includes('Call Stack:\nStorageError: GCS bucket unreachable'));
      // Ensure Error: {...} is not printed on the metadata summary line
      assert.ok(!output.split('\n')[0]?.includes('Error:'));
    });

    void it('should treat falsy error metadata ({ error: false }, { error: 0 }) as benign metadata without generating fake Error Detail', () => {
      const { appLogger, stream } = createMemoryLogger();

      appLogger.info('Request succeeded', { error: false, status: 200 });
      let output = stream.output;
      assert.ok(output.includes('[info]: Request succeeded | Error: false | Status: 200'));
      assert.ok(!output.includes('Error Detail:'));
      assert.ok(!output.includes('Call Stack:'));

      stream.clear();
      appLogger.info('Zero error status', { error: 0 });
      output = stream.output;
      assert.ok(output.includes('[info]: Zero error status | Error: 0'));
      assert.ok(!output.includes('Error Detail:'));
      assert.ok(!output.includes('Call Stack:'));
    });

    void it('should respect process.env.LOG_LEVEL during createAppLogger instantiation', () => {
      const prevEnv = process.env['LOG_LEVEL'];
      try {
        process.env['LOG_LEVEL'] = 'DEBUG';
        const stream = new MemoryLogStream();
        const appLog = createAppLogger({
          transports: [new winston.transports.Stream({ stream })],
        });
        appLog.debug('Debug from env level');
        assert.ok(stream.output.includes('[debug]: Debug from env level'));
      } finally {
        if (prevEnv !== undefined) {
          process.env['LOG_LEVEL'] = prevEnv;
        } else {
          delete process.env['LOG_LEVEL'];
        }
      }
    });

    void it('should escape control characters and ANSI sequences via escapeForConsole', () => {
      assert.equal(escapeForConsole('hello world'), 'hello world');
      assert.equal(escapeForConsole('line1\nline2'), 'line1\\nline2');
      assert.equal(escapeForConsole('line1\r\nline2'), 'line1\\r\\nline2');
      assert.equal(escapeForConsole('tab\there'), 'tab\\there');
      assert.equal(escapeForConsole('\x1b[31mred\x1b[0m'), '\\x1b[31mred\\x1b[0m');
      assert.equal(escapeForConsole('null\0byte'), 'null\\0byte');
      assert.equal(escapeForConsole('sep\u2028line'), 'sep\\u2028line');
      assert.equal(escapeForConsole('del\x7fchar'), 'del\\x7fchar');
    });

    void it('should preserve call stack indentation while escaping hostile control characters via escapeCallStack', () => {
      const rawStack =
        'Error: something failed\n    at Object.test (/app/test.js:10:5)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)';
      const escaped = escapeCallStack(rawStack);
      assert.equal(escaped, rawStack);

      const hostileStack =
        'Error: boom\x1b[31mRED\n    at func\n\r2026-10-08T00:00:00.000Z [error]: FORGED LINE';
      const escapedHostile = escapeCallStack(hostileStack);
      assert.ok(!escapedHostile.includes('\x1b[31m'));
      assert.ok(escapedHostile.includes('\\x1b[31mRED'));
      assert.ok(escapedHostile.includes('\\r2026-10-08T00:00:00.000Z [error]: FORGED LINE'));
    });

    void it('should prevent multiline error messages from forging call stack records when logged through real logger', () => {
      const { appLogger, stream } = createMemoryLogger();
      const hostileErr = new Error(
        'bad path /profile\n2026-10-08T00:00:00.000Z [error]: FORGED LOG LINE\r\x1b[31mRED',
      );

      appLogger.error('Unhandled failure', hostileErr);
      const output = stream.output;

      // Unescaped newline must not appear as a separate top-level log line
      assert.ok(
        !output.includes('\n2026-10-08T00:00:00.000Z [error]: FORGED LOG LINE'),
        'Forged log line must not be emitted unescaped in Call Stack section',
      );
      // Raw carriage return and ANSI codes must not be present
      assert.ok(!output.includes('\r2026'));
      assert.ok(!output.includes('\x1b[31m'));
      // Escaped representation should be present
      assert.ok(
        output.includes('\\n2026-10-08T00:00:00.000Z [error]: FORGED LOG LINE\\r\\x1b[31mRED'),
      );
    });

    void it('should not treat caller-supplied callStack/errorDetail metadata as authentic stack structure', () => {
      const forged = 'a\n2026-10-08T00:00:00.000Z [error]: FORGED LINE';

      // Without a real error: metadata keys must not produce Call Stack / Error Detail sections
      const plain = createMemoryLogger();
      plain.appLogger.error('Plain failure', { callStack: forged, errorDetail: forged });
      assert.ok(!plain.stream.output.includes('Call Stack:'));
      assert.ok(!plain.stream.output.includes('Error Detail:'));
      assert.ok(!plain.stream.output.includes('\n2026-10-08T00:00:00.000Z [error]: FORGED LINE'));
      assert.ok(plain.stream.output.includes('UserCallStack: a\\n2026-10-08T00:00:00.000Z'));

      // With a real error: the generated stack is rendered, the spoofed metadata is not
      const withError = createMemoryLogger();
      withError.appLogger.error('Real failure', new Error('genuine'), { callStack: forged });
      const output = withError.stream.output;
      assert.ok(output.includes('Call Stack:\nError: genuine'));
      assert.ok(!output.includes('\n2026-10-08T00:00:00.000Z [error]: FORGED LINE'));
      assert.ok(output.includes('UserCallStack: a\\n2026-10-08T00:00:00.000Z'));
    });

    void it('should log decisions at custom log levels when specified in DecisionLogPayload', () => {
      const infoLogger = createMemoryLogger({ level: 'info' });
      infoLogger.appLogger.decision({
        action: 'MimeResolver',
        choice: 'MIME type text/css',
        reason: 'Mapped from table',
        level: 'debug',
      });
      // Since logger is at 'info', debug decision should not be printed
      assert.equal(infoLogger.stream.output, '');

      infoLogger.appLogger.decision({
        action: 'Router',
        choice: 'SPA fallback',
        reason: 'Extensionless route',
        level: 'info',
      });
      assert.ok(
        infoLogger.stream.output.includes('[info]: Decision [Router] | Choice: SPA fallback'),
      );

      infoLogger.stream.clear();
      infoLogger.appLogger.decision({
        action: 'PathSanitizer',
        choice: 'reject request (400)',
        reason: 'Traversal detected',
        level: 'warn',
      });
      assert.ok(
        infoLogger.stream.output.includes(
          '[warn]: Decision [PathSanitizer] | Choice: reject request (400)',
        ),
      );

      // Test logDecision helper with custom level
      infoLogger.stream.clear();
      logDecision(infoLogger.appLogger, {
        action: 'HttpMethodValidator',
        choice: 'reject request (405)',
        reason: 'POST not allowed',
        level: 'warn',
      });
      assert.ok(
        infoLogger.stream.output.includes(
          '[warn]: Decision [HttpMethodValidator] | Choice: reject request (405)',
        ),
      );
    });

    void it('should sanitize function values in console and JSON metadata without leaking source code', () => {
      function secretCallback() {
        return 'SECRET_PASSWORD_TOKEN';
      }

      // Console format
      const consoleLog = createMemoryLogger();
      consoleLog.appLogger.info('fnmeta', { handler: secretCallback });
      assert.ok(consoleLog.stream.output.includes('Handler: null'));
      assert.ok(!consoleLog.stream.output.includes('secretCallback'));
      assert.ok(!consoleLog.stream.output.includes('SECRET_PASSWORD_TOKEN'));

      // JSON format
      const jsonLog = createMemoryLogger({ json: true });
      jsonLog.appLogger.info('fnmeta', { handler: secretCallback });
      const parsedJson = JSON.parse(jsonLog.stream.output.trim()) as Record<string, unknown>;
      assert.equal(parsedJson['handler'], 'null');
      assert.ok(!jsonLog.stream.output.includes('secretCallback'));
      assert.ok(!jsonLog.stream.output.includes('SECRET_PASSWORD_TOKEN'));

      // Decision telemetry
      consoleLog.stream.clear();
      consoleLog.appLogger.decision({
        action: 'Auth',
        choice: 'Authenticate',
        reason: 'Valid token',
        cb: secretCallback,
      } as unknown as DecisionLogPayload);
      assert.ok(consoleLog.stream.output.includes('Cb: null'));
      assert.ok(!consoleLog.stream.output.includes('secretCallback'));
    });
  });
});
