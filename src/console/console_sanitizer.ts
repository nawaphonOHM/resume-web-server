/**
 * Console sanitization to prevent log injection and ANSI formatting exploits.
 *
 * @packageDocumentation
 */

import { BYTE_MAX, HEX_PAD_FOUR, HEX_PAD_TWO, RADIX_HEX } from '../logger/logger_types.ts';

const MAX_CONTROL_CODE = 0x1f;
const CONTROL_CODE_DEL = 0x7f;
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

const NAMED_ESCAPES: Readonly<Record<string, string | undefined>> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
  '\v': '\\v',
  '\x1b': '\\x1b',
  '\0': '\\0',
};

function isSeparatorCode(code: number): boolean {
  return code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;
}

function isControlCode(code: number): boolean {
  return code <= MAX_CONTROL_CODE || code === CONTROL_CODE_DEL || isSeparatorCode(code);
}

function formatHexEscape(code: number): string {
  if (code <= BYTE_MAX) {
    return `\\x${code.toString(RADIX_HEX).padStart(HEX_PAD_TWO, '0')}`;
  }
  return `\\u${code.toString(RADIX_HEX).padStart(HEX_PAD_FOUR, '0')}`;
}

function escapeControlChar(char: string): string {
  const named = NAMED_ESCAPES[char];
  if (named !== undefined) {
    return named;
  }
  return formatHexEscape(char.charCodeAt(0));
}

/**
 * Escapes control characters, ANSI escape sequences, line breaks, and raw control bytes in strings
 * to prevent terminal log injection, ANSI formatting exploits, or fake log line forgery.
 *
 * @param str - The raw untrusted string to escape.
 * @returns Escaped safe string for console logging.
 */
export function escapeForConsole(str: string): string {
  let result = '';
  for (const char of str) {
    const code = char.charCodeAt(0);
    result += isControlCode(code) ? escapeControlChar(char) : char;
  }
  return result;
}

function formatStackLine(line: string): string {
  const match = /^([ \t]*)(.*)$/.exec(line);
  if (match) {
    return match[1] + escapeForConsole(match[2]);
  }
  return escapeForConsole(line);
}

/**
 * Escapes control characters and ANSI sequences within a multi-line Java-style stack trace
 * while preserving standard newline line breaks and leading indentation spaces/tabs.
 *
 * @param callStack - Multi-line stack trace string.
 * @returns Escaped multi-line stack trace.
 */
export function escapeCallStack(callStack: string): string {
  return callStack.split(/\r?\n/).map(formatStackLine).join('\n');
}
