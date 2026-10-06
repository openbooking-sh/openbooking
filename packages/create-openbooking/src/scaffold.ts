import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

export interface ScaffoldOptions {
  /** Directory to create. Must not exist or be empty. */
  dir: string;
  /** Shown in the booking page, emails and Studio, e.g. "Studio Nord". */
  businessName: string;
  /** Version range of the @openbooking-sh packages to depend on, e.g. "0.1.0". */
  version: string;
  /** Template directory (defaults to the one shipped with the package). */
  templateDir: string;
}

/** Files npm would strip or rename on publish are stored under other names in the template. */
const RENAMES: Record<string, string> = { gitignore: '.gitignore', 'env.example': '.env.example' };
const TEXT = /\.(ts|json|md|example)$|gitignore$/;

/** `Studio Nord!` → `studio-nord`. Valid npm package name and venue id. */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      // Norwegian letters before NFKD, which would split å into a + ring.
      .replace(/æ/g, 'ae')
      .replace(/ø/g, 'o')
      .replace(/å/g, 'a')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'my-booking'
  );
}

/**
 * Recursive copy. Not fs.cpSync: on Windows it garbles non-ASCII destination paths
 * ("Studio Nørd" becomes "Studio NÃ¸rd"), and folder names like "Frisør Bjørn" are common here.
 */
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else copyFileSync(src, dest);
  }
}

/** Copy the template into `dir` and fill in names. Returns the files written, relative to `dir`. */
export function scaffold(options: ScaffoldOptions): string[] {
  const { dir } = options;
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`${dir} already exists and isn't empty. Pick another name.`);
  }
  copyDir(options.templateDir, dir);

  const projectName = slug(relative(join(dir, '..'), dir) || options.businessName);
  const values: Record<string, string> = {
    PROJECT_NAME: projectName,
    BUSINESS_NAME: options.businessName.replace(/["'`\\$]/g, ''),
    OPENBOOKING_VERSION: options.version,
  };

  const written: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      let path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      const renamed = RENAMES[entry.name];
      if (renamed) {
        const target = join(current, renamed);
        renameSync(path, target);
        path = target;
      }
      if (TEXT.test(path)) {
        const text = readFileSync(path, 'utf8');
        writeFileSync(
          path,
          text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => values[key] ?? m),
        );
      }
      written.push(relative(dir, path).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return written.sort();
}
