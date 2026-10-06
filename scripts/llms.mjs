// Builds llms.txt (index) and llms-full.txt (everything an AI coding tool needs, in one file) at
// the repo root. Run: node scripts/llms.mjs (also part of `pnpm docs`).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8').trim();
const raw = 'https://raw.githubusercontent.com/openbooking-sh/openbooking/main';
const gh = 'https://github.com/openbooking-sh/openbooking/blob/main';
const packages = readdirSync(new URL('packages', root)).sort();

const summary =
  '> OpenBooking is an open-source TypeScript SDK and booking backend that makes any website or booking platform bookable by AI assistants (Claude, ChatGPT, Gemini, AI browsers) through MCP, WebMCP and UCP. It enforces agent safety: holds that expire, idempotent retries that never double-book, explicit customer consent, and cancellation terms shown before booking. Packages are published on npm as @openbooking-sh/*.';

const index = `# OpenBooking

${summary}

## Start here

- [Recipes](${gh}/docs/RECIPES.md): one-file backend, Postgres, Vercel, website snippet, custom booking systems, rules for AI coding tools
- [README](${gh}/README.md): install, packages, quickstart
- [Full docs in one file](${raw}/llms-full.txt)

## Packages

${packages.map((p) => `- [@openbooking-sh/${p}](${gh}/packages/${p}/README.md)`).join('\n')}

## Reference

- [Architecture](${gh}/docs/ARCHITECTURE.md)
- [Hosted OpenBooking](${gh}/docs/HOSTED.md)
- [Protocol notes (MCP, UCP, A2A)](${gh}/docs/SPEC-NOTES.md)

## Optional

- [Hosted service](https://app.openbooking.sh/signup): businesses can sign up without code
- [Website](https://openbooking.sh)
`;

const sections = [
  ['docs/RECIPES.md', 'Recipes'],
  ['README.md', 'README'],
  ...packages.map((p) => [`packages/${p}/README.md`, `@openbooking-sh/${p}`]),
  ['docs/ARCHITECTURE.md', 'Architecture'],
  ['docs/HOSTED.md', 'Hosted OpenBooking'],
];
const full = `# OpenBooking: full documentation for AI tools

${summary}

${sections.map(([p, title]) => `\n<!-- ${title} (${p}) -->\n\n${read(p)}\n`).join('\n---\n')}`;

writeFileSync(new URL('llms.txt', root), index);
writeFileSync(new URL('llms-full.txt', root), full);
console.log(`llms.txt and llms-full.txt (${Math.round(full.length / 1024)} KB)`);
