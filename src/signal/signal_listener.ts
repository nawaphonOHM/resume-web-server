/**
 * OS process signal listener binding helpers.
 *
 * @packageDocumentation
 */

import process from 'node:process';

function attachSignalListener(signal: NodeJS.Signals, handler: () => void): () => void {
  process.on(signal, handler);
  return () => {
    process.off(signal, handler);
  };
}

function wrapSignalListener(signal: NodeJS.Signals, onSignal: (sig: string) => void): () => void {
  return attachSignalListener(signal, () => {
    onSignal(signal);
  });
}

/**
 * Binds `SIGTERM` and `SIGINT` handlers to the Node process and returns an unbind function.
 *
 * @param onSignal - Callback invoked with the received signal name.
 * @returns Teardown function to unbind both signal listeners.
 */
export function bindProcessSignals(onSignal: (sig: string) => void): () => void {
  const offTerm = wrapSignalListener('SIGTERM', onSignal);
  const offInt = wrapSignalListener('SIGINT', onSignal);
  return () => {
    offTerm();
    offInt();
  };
}
