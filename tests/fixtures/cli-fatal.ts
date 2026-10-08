/**
 * Test fixture executable for verifying CLI fatal process handlers, stream flushing, and error formatting.
 */
import { registerFatalProcessHandlers } from '../../src/index.ts';

registerFatalProcessHandlers();

const mode = process.argv[2] ?? '';

switch (mode) {
  case 'uncaught-error':
    setImmediate(() => {
      throw new Error('Simulated uncaught exception');
    });
    break;
  case 'uncaught-string':
    setImmediate(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- intentional test for string throw formatting
      throw 'Simulated uncaught string error';
    });
    break;
  case 'unhandled-error':
    setImmediate(() => {
      void Promise.reject(new Error('Simulated unhandled promise rejection'));
    });
    break;
  case 'unhandled-object':
    setImmediate(() => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- simulated non-Error rejection containing sensitive fields
      void Promise.reject({
        status: 500,
        detail: 'Plain object rejection reason',
        authorization: 'Bearer super-secret-token',
        apiKey: 'SECRET-KEY-12345',
      });
    });
    break;
  case 'unhandled-string':
    setImmediate(() => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- simulated primitive string rejection
      void Promise.reject('Plain string rejection reason');
    });
    break;
  default:
    throw new Error(`Unknown fatal test fixture mode: ${mode}`);
}
