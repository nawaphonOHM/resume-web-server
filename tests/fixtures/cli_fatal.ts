/**
 * Test fixture executable for verifying CLI fatal process handlers, stream flushing, and error formatting.
 */
import process from 'node:process';
import { runInThisContext } from 'node:vm';
import { registerFatalProcessHandlers } from '../../src/index.ts';

registerFatalProcessHandlers();

const mode = process.argv[2] ?? '';

const sampleObjectPayload = {
  status: 500,
  detail: 'Plain object rejection reason',
  authorization: 'Bearer super-secret-token',
  apiKey: 'SECRET-KEY-12345',
};

/**
 * Evaluates source in the current context so genuine non-Error values are thrown/rejected
 * by the runtime itself (no type assertions or emitted events involved).
 */
function runSource(source: string): void {
  runInThisContext(source);
}

switch (mode) {
  case 'uncaught-error':
    setImmediate(() => {
      throw new Error('Simulated uncaught exception');
    });
    break;
  case 'uncaught-string':
    runSource("setImmediate(() => { throw 'Simulated uncaught string error'; });");
    break;
  case 'unhandled-error':
    setImmediate(() => {
      void Promise.reject(new Error('Simulated unhandled promise rejection'));
    });
    break;
  case 'unhandled-object':
    runSource(`setImmediate(() => { Promise.reject(${JSON.stringify(sampleObjectPayload)}); });`);
    break;
  case 'unhandled-string':
    runSource("setImmediate(() => { Promise.reject('Plain string rejection reason'); });");
    break;
  default:
    throw new Error(`Unknown fatal test fixture mode: ${mode}`);
}
