import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffold, slug } from '../src/scaffold';

const templateDir = fileURLToPath(new URL('../template', import.meta.url));
const temps: string[] = [];
afterEach(() => temps.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'create-openbooking-'));
  temps.push(d);
  return d;
};

const VERSIONS = { server: '0.2.0', postgres: '0.3.0', 'provider-memory': '0.2.1' };

describe('create-openbooking', () => {
  it('writes a ready-to-run project with names and versions filled in', () => {
    const dir = join(tmp(), 'Studio Nørd');
    const files = scaffold({ dir, businessName: 'Studio Nørd', versions: VERSIONS, templateDir });
    expect(files).toEqual(
      [
        '.env.example',
        '.gitignore',
        'AGENTS.md',
        'README.md',
        'api/index.ts',
        'app.ts',
        'business.ts',
        'package.json',
        'server.ts',
        'tsconfig.json',
        'vercel.json',
      ].sort(),
    );
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('studio-nord');
    expect(pkg.dependencies['@openbooking-sh/server']).toBe('^0.2.0');
    expect(pkg.dependencies['@openbooking-sh/postgres']).toBe('^0.3.0');
    expect(pkg.dependencies['@openbooking-sh/provider-memory']).toBe('^0.2.1');
    const business = readFileSync(join(dir, 'business.ts'), 'utf8');
    expect(business).toContain("name: 'Studio Nørd'");
    expect(business).toContain("const VENUE = 'studio-nord'");
    for (const f of files)
      expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it('refuses a folder that already has files', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'keep.txt'), 'mine');
    expect(() => scaffold({ dir, businessName: 'X', versions: VERSIONS, templateDir })).toThrow(
      /isn't empty/,
    );
  });

  it('keeps business names from breaking the generated code', () => {
    const dir = join(tmp(), 'quote');
    scaffold({ dir, businessName: "Bob's `Cuts` $1", versions: VERSIONS, templateDir });
    expect(readFileSync(join(dir, 'business.ts'), 'utf8')).toContain("name: 'Bobs Cuts 1'");
    expect(slug('Bjørn & Åse Frisør')).toBe('bjorn-ase-frisor');
  });
});
