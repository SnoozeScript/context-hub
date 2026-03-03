import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'bin', 'chub');
const FIXTURES = join(__dirname, 'fixtures');
const BUILD_OUTPUT = join(FIXTURES, 'dist');

let tmpChubDir;

function chub(args, { expectError = false } = {}) {
  try {
    const result = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', CHUB_DIR: tmpChubDir },
      timeout: 10000,
    });
    return result;
  } catch (err) {
    if (expectError) return err.stderr || err.stdout || err.message;
    throw err;
  }
}

function chubJSON(args) {
  const out = chub([...args, '--json']);
  return JSON.parse(out);
}

describe('chub CLI e2e', () => {
  beforeAll(() => {
    // Use an isolated temp directory so we never touch ~/.chub
    tmpChubDir = mkdtempSync(join(tmpdir(), 'chub-e2e-'));

    // Build fixtures
    chub(['build', FIXTURES]);

    // Point config at fixture build output (local source only)
    writeFileSync(join(tmpChubDir, 'config.yaml'), `sources:\n  - name: test\n    path: ${BUILD_OUTPUT}\n\nsource: official,maintainer,community\n`);
  });

  afterAll(() => {
    // Clean up temp dir and build output
    rmSync(tmpChubDir, { recursive: true, force: true });
    rmSync(BUILD_OUTPUT, { recursive: true, force: true });
  });

  describe('build', () => {
    it('produces registry.json', () => {
      expect(existsSync(join(BUILD_OUTPUT, 'registry.json'))).toBe(true);
    });

    it('registry has correct counts', () => {
      const reg = JSON.parse(readFileSync(join(BUILD_OUTPUT, 'registry.json'), 'utf8'));
      expect(reg.docs.length).toBe(2); // acme/widgets + multilang/client
      expect(reg.skills.length).toBe(1); // testskills/deploy
    });

    it('copies content files to output', () => {
      expect(existsSync(join(BUILD_OUTPUT, 'acme', 'docs', 'widgets', 'DOC.md'))).toBe(true);
      expect(existsSync(join(BUILD_OUTPUT, 'acme', 'docs', 'widgets', 'references', 'advanced.md'))).toBe(true);
    });

    it('validates with --validate-only', () => {
      const out = chub(['build', FIXTURES, '--validate-only']);
      expect(out).toContain('2 docs');
      expect(out).toContain('1 skills');
    });

    it('errors on missing content dir', () => {
      const out = chub(['build', '/nonexistent/path'], { expectError: true });
      expect(out).toContain('Content directory not found');
    });
  });

  describe('search', () => {
    it('lists all entries', () => {
      const data = chubJSON(['search']);
      expect(data.total).toBe(3); // 2 docs + 1 skill
    });

    it('fuzzy search finds by name', () => {
      const data = chubJSON(['search', 'widget']);
      expect(data.results.length).toBe(1);
      expect(data.results[0].id).toBe('acme/widgets');
    });

    it('fuzzy search finds by description', () => {
      const data = chubJSON(['search', 'deployment']);
      expect(data.results.length).toBe(1);
      expect(data.results[0].id).toBe('testskills/deploy');
    });

    it('exact id shows detail', () => {
      const data = chubJSON(['search', 'acme/widgets']);
      // Exact match returns the entry directly, not wrapped in results[]
      expect(data.id).toBe('acme/widgets');
      expect(data.languages).toBeDefined();
    });

    it('filters by tag', () => {
      const data = chubJSON(['search', '--tags', 'automation']);
      expect(data.results.length).toBe(1);
      expect(data.results[0].id).toBe('testskills/deploy');
    });

    it('returns empty for no match', () => {
      const data = chubJSON(['search', 'nonexistentthing']);
      expect(data.results.length).toBe(0);
    });
  });

  describe('get', () => {
    it('fetches single-language doc (auto-infers lang)', () => {
      const out = chub(['get', 'acme/widgets']);
      expect(out).toContain('# Acme Widgets API');
      expect(out).toContain('npm install @acme/widgets');
    });

    it('fetches multi-language doc with --lang', () => {
      const out = chub(['get', 'multilang/client', '--lang', 'py']);
      expect(out).toContain('# Multilang Client — Python');
      expect(out).toContain('from multilang import Client');
    });

    it('fetches js variant with --lang js', () => {
      const out = chub(['get', 'multilang/client', '--lang', 'js']);
      expect(out).toContain('# Multilang Client — JavaScript');
      expect(out).toContain("import { Client } from 'multilang'");
    });

    it('errors on multi-lang without --lang', () => {
      const out = chub(['get', 'multilang/client'], { expectError: true });
      expect(out).toContain('Multiple languages');
      expect(out).toContain('--lang');
    });

    it('errors on nonexistent entry', () => {
      const out = chub(['get', 'fake/thing'], { expectError: true });
      expect(out).toContain('not found');
    });

    it('fetches --full with all files', () => {
      const out = chub(['get', 'acme/widgets', '--full']);
      expect(out).toContain('FILE: DOC.md');
      expect(out).toContain('FILE: references/advanced.md');
      expect(out).toContain('Batch Operations');
    });

    it('writes to file with -o', () => {
      const tmpFile = join(BUILD_OUTPUT, '_test_output.md');
      chub(['get', 'acme/widgets', '-o', tmpFile]);
      expect(existsSync(tmpFile)).toBe(true);
      const content = readFileSync(tmpFile, 'utf8');
      expect(content).toContain('# Acme Widgets API');
      rmSync(tmpFile, { force: true });
    });

    it('fetches skill content', () => {
      const out = chub(['get', 'testskills/deploy']);
      expect(out).toContain('# Deploy Skill');
      expect(out).toContain('Automate deployments');
    });

    it('shows footer with additional files when they exist', () => {
      const out = chub(['get', 'acme/widgets']);
      expect(out).toContain('Additional files available');
      expect(out).toContain('references/advanced.md');
      expect(out).toContain('--file');
    });

    it('no footer when entry has only one file', () => {
      const out = chub(['get', 'multilang/client', '--lang', 'js']);
      expect(out).not.toContain('Additional files available');
    });

    it('fetches specific file with --file', () => {
      const out = chub(['get', 'acme/widgets', '--file', 'references/advanced.md']);
      expect(out).toContain('Batch Operations');
      expect(out).not.toContain('# Acme Widgets API');
    });

    it('errors on nonexistent --file with available list', () => {
      const out = chub(['get', 'acme/widgets', '--file', 'nonexistent.md'], { expectError: true });
      expect(out).toContain('not found in acme/widgets');
      expect(out).toContain('references/advanced.md');
    });

    it('--json includes additionalFiles array', () => {
      const data = chubJSON(['get', 'acme/widgets']);
      expect(data.additionalFiles).toContain('references/advanced.md');
    });

    it('--json omits additionalFiles when none exist', () => {
      const data = chubJSON(['get', 'multilang/client', '--lang', 'js']);
      expect(data.additionalFiles).toBeUndefined();
    });
  });

  describe('json output', () => {
    it('search --json returns valid JSON with total', () => {
      const data = chubJSON(['search']);
      expect(typeof data.total).toBe('number');
      expect(Array.isArray(data.results)).toBe(true);
    });

    it('build --json returns valid JSON', () => {
      const data = chubJSON(['build', FIXTURES, '--validate-only']);
      expect(typeof data.docs).toBe('number');
      expect(typeof data.skills).toBe('number');
    });
  });
});
