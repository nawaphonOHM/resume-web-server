/**
 * Candidate filtering and newest-to-oldest sorting for recursive storage search.
 *
 * @packageDocumentation
 */

import type { File } from '@google-cloud/storage';
import { parseTimestampFromDirectory } from './storage_timestamp_parser.ts';
import type { CandidateFileMatch, LocateResult } from './storage_types.ts';

const SORT_BEFORE = -1;
const SORT_AFTER = 1;

interface TimestampedMatch extends CandidateFileMatch {
  readonly unixtime: number;
}

function extractDirectoryMeta(segments: string[]): {
  unixtime: number | null;
  directoryName: string;
} {
  if (segments.length <= 1) return { unixtime: null, directoryName: '' };
  const directoryName = segments[0];
  return { unixtime: parseTimestampFromDirectory(directoryName), directoryName };
}

function isPrefixed(name: string, prefix: string): boolean {
  return prefix === '' || name.startsWith(`${prefix}/`);
}

function getRelativeUnderPrefix(name: string, prefix: string): string | null {
  if (!isPrefixed(name, prefix)) return null;
  return prefix ? name.slice(prefix.length + 1) : name;
}

function isValidRelativeCandidate(
  relative: string | null,
  targetBasename: string,
): relative is string {
  if (!relative || relative.endsWith('/')) return false;
  return relative.split('/').pop() === targetBasename;
}

export function extractCandidateMatch(
  file: File,
  cleanPrefix: string,
  targetBasename: string,
): CandidateFileMatch | null {
  const relative = getRelativeUnderPrefix(file.name, cleanPrefix);
  if (!isValidRelativeCandidate(relative, targetBasename)) return null;
  const { unixtime, directoryName } = extractDirectoryMeta(relative.split('/'));
  return { file, fullPath: file.name, unixtime, directoryName };
}

function isTimestamped(match: CandidateFileMatch): match is TimestampedMatch {
  return match.unixtime !== null;
}

function compareTimestamped(a: TimestampedMatch, b: TimestampedMatch): number {
  const diff = b.unixtime - a.unixtime;
  if (diff !== 0) return diff;
  return a.fullPath.localeCompare(b.fullPath);
}

function compareUnbalanced(a: CandidateFileMatch, b: CandidateFileMatch): number {
  if (a.unixtime !== null) return SORT_BEFORE;
  if (b.unixtime !== null) return SORT_AFTER;
  return a.fullPath.localeCompare(b.fullPath);
}

export function compareCandidates(a: CandidateFileMatch, b: CandidateFileMatch): number {
  if (isTimestamped(a) && isTimestamped(b)) return compareTimestamped(a, b);
  return compareUnbalanced(a, b);
}

function normalizePrefix(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

function getBasename(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1];
}

function matchFiles(files: File[], prefix: string, target: string): CandidateFileMatch[] {
  return files
    .map((f) => extractCandidateMatch(f, prefix, target))
    .filter((m): m is CandidateFileMatch => m !== null);
}

export function findMatchingCandidates(
  files: File[],
  prefix: string,
  targetName: string,
): CandidateFileMatch[] {
  return matchFiles(files, normalizePrefix(prefix), getBasename(targetName));
}

function formatBestMatch(best: CandidateFileMatch): LocateResult {
  return {
    file: best.file,
    fullPath: best.fullPath,
    strategy: 'recursive',
    unixtime: best.unixtime ?? undefined,
  };
}

export function resolveRecursiveResult(candidates: CandidateFileMatch[]): LocateResult | null {
  if (candidates.length === 0) return null;
  candidates.sort(compareCandidates);
  return formatBestMatch(candidates[0]);
}
