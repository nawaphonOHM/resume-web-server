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

interface DirMeta {
  readonly unixtime: number | null;
  readonly directoryName: string;
}

function extractDirectoryMeta(segments: string[]): DirMeta {
  if (segments.length <= 1) return { unixtime: null, directoryName: '' };
  return { unixtime: parseTimestampFromDirectory(segments[0]), directoryName: segments[0] };
}

function getRelativeUnderPrefix(name: string, prefix: string): string | null {
  if (prefix === '') return name;
  if (!name.startsWith(`${prefix}/`)) return null;
  return name.slice(prefix.length + 1);
}

function matchesTarget(rel: string, target: string): boolean {
  if (rel === target) return true;
  return rel.endsWith(`/${target}`);
}

function isValidRelativeCandidate(rel: string | null, target: string): rel is string {
  if (!rel) return false;
  if (rel.endsWith('/')) return false;
  return matchesTarget(rel, target);
}

function trimSlashes(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

function computeExtraSegments(segments: string[], target: string): number {
  const depth = segments.length > 1 ? segments.length - 1 : segments.length;
  return depth - target.split('/').length;
}

function buildCandidate(file: File, rel: string, target: string): CandidateFileMatch {
  const segments = rel.split('/');
  const meta = extractDirectoryMeta(segments);
  const extraSegments = computeExtraSegments(segments, target);
  return { file, fullPath: file.name, ...meta, extraSegments };
}

export function extractCandidateMatch(
  file: File,
  prefix: string,
  target: string,
): CandidateFileMatch | null {
  const clean = trimSlashes(target);
  const rel = getRelativeUnderPrefix(file.name, trimSlashes(prefix));
  if (!isValidRelativeCandidate(rel, clean)) return null;
  return buildCandidate(file, rel, clean);
}

function isTimestamped(match: CandidateFileMatch): match is TimestampedMatch {
  return match.unixtime !== null;
}

function getDepth(match: CandidateFileMatch): number {
  return match.extraSegments ?? 0;
}

function compareDepthAndPath(a: CandidateFileMatch, b: CandidateFileMatch): number {
  const diff = getDepth(a) - getDepth(b);
  if (diff !== 0) return diff;
  return a.fullPath.localeCompare(b.fullPath);
}

function compareTimestamped(a: TimestampedMatch, b: TimestampedMatch): number {
  const diff = b.unixtime - a.unixtime;
  if (diff !== 0) return diff;
  return compareDepthAndPath(a, b);
}

function compareUnbalanced(a: CandidateFileMatch, b: CandidateFileMatch): number {
  if (a.unixtime !== null) return SORT_BEFORE;
  if (b.unixtime !== null) return SORT_AFTER;
  return compareDepthAndPath(a, b);
}

export function compareCandidates(a: CandidateFileMatch, b: CandidateFileMatch): number {
  if (isTimestamped(a) && isTimestamped(b)) return compareTimestamped(a, b);
  return compareUnbalanced(a, b);
}

function matchFiles(files: File[], prefix: string, target: string): CandidateFileMatch[] {
  return files
    .map((f) => extractCandidateMatch(f, prefix, target))
    .filter((m): m is CandidateFileMatch => m !== null);
}

export function findMatchingCandidates(
  files: File[],
  prefix: string,
  target: string,
): CandidateFileMatch[] {
  return matchFiles(files, trimSlashes(prefix), trimSlashes(target));
}

function formatBestMatch(best: CandidateFileMatch): LocateResult {
  const unixtime = best.unixtime ?? undefined;
  return { file: best.file, fullPath: best.fullPath, strategy: 'recursive', unixtime };
}

export function resolveRecursiveResult(candidates: CandidateFileMatch[]): LocateResult | null {
  if (candidates.length === 0) return null;
  candidates.sort(compareCandidates);
  return formatBestMatch(candidates[0]);
}
