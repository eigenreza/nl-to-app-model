#!/usr/bin/env node
/**
 * Repository hygiene check.
 *
 * The project uses a restricted punctuation set so that generated content,
 * hand-written prose and source code all look the same in diffs, terminals and
 * fixtures. This script fails the build when a disallowed character appears in
 * a tracked (or newly added, non-ignored) text file.
 *
 * Characters are referenced by escape sequence on purpose, so that the checker
 * itself never contains the characters it rejects.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';

const ROOT = process.cwd();

const DISALLOWED = [
  {
    code: 0x2014,
    name: 'EM DASH',
    suggestion: 'use a comma, a colon, parentheses, or two sentences',
  },
  { code: 0x2015, name: 'HORIZONTAL BAR', suggestion: 'use a hyphen or restructure the sentence' },
];

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.css',
  '.html',
  '.yml',
  '.yaml',
  '.txt',
  '.env',
  '.example',
  '.sh',
  '.mts',
  '.cts',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '_admin',
  '.vite',
  '.eval-cache',
]);

function listFilesFromGit() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function listFilesFromDisk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listFilesFromDisk(join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(relative(ROOT, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return acc;
}

function isTextFile(relPath) {
  if (relPath.split('/').some((part) => SKIP_DIRS.has(part))) return false;
  const ext = extname(relPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // Extensionless dotfiles such as .gitignore or .nvmrc.
  return ext === '' && relPath.split('/').pop().startsWith('.');
}

const files = (listFilesFromGit() ?? listFilesFromDisk(ROOT)).filter(isTextFile);

const violations = [];

for (const relPath of files) {
  let stat;
  try {
    stat = statSync(join(ROOT, relPath));
  } catch {
    continue; // Deleted between listing and reading.
  }
  if (!stat.isFile() || stat.size > 2_000_000) continue;

  const contents = readFileSync(join(ROOT, relPath), 'utf8');
  const lines = contents.split(/\r?\n/);

  for (const rule of DISALLOWED) {
    const char = String.fromCodePoint(rule.code);
    if (!contents.includes(char)) continue;
    lines.forEach((line, index) => {
      let column = line.indexOf(char);
      while (column !== -1) {
        violations.push({
          file: relPath,
          line: index + 1,
          column: column + 1,
          rule,
        });
        column = line.indexOf(char, column + 1);
      }
    });
  }
}

if (violations.length === 0) {
  console.log(`charset check: ${files.length} files scanned, no disallowed characters found.`);
  process.exit(0);
}

console.error(`charset check failed: ${violations.length} disallowed character(s) found.\n`);
for (const v of violations) {
  const hex = v.rule.code.toString(16).toUpperCase().padStart(4, '0');
  console.error(
    `  ${v.file}:${v.line}:${v.column}  U+${hex} ${v.rule.name} (${v.rule.suggestion})`,
  );
}
console.error('');
process.exit(1);
