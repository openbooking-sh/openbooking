/**
 * npx create-openbooking my-salon
 * npm create openbooking@latest my-salon -- --name "Studio Nord"
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { scaffold, slug } from './scaffold';

declare const __OPENBOOKING_VERSIONS__: Record<string, string>;

const HELP = `
  create-openbooking: a booking backend that AI assistants can book, in one command.

  Usage
    npx create-openbooking [dir] [--name "Business name"] [--no-install]

  You get a booking page, a one-line website snippet, a dashboard (Studio), and booking for AI
  assistants over MCP, UCP and A2A. Edit business.ts for staff, services and opening hours.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let dir = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--name');
  let name = flag('--name');

  if (process.stdin.isTTY && (!dir || !name)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    name ||= (await rl.question('  Business name (Studio Nord): ')).trim() || 'Studio Nord';
    dir ||= (await rl.question(`  Folder (${slug(name)}): `)).trim() || slug(name);
    rl.close();
  }
  name ||= 'My Business';
  dir ||= slug(name);

  const target = resolve(dir);
  const templateDir = fileURLToPath(new URL('../template', import.meta.url));
  scaffold({ dir: target, businessName: name, versions: __OPENBOOKING_VERSIONS__, templateDir });
  console.log(`\n  Created ${name} in ${target}\n`);

  // Install with whatever the user ran us with (npm, pnpm, yarn or bun).
  const pm = (process.env.npm_config_user_agent ?? 'npm').split('/')[0] || 'npm';
  let installed = false;
  if (!args.includes('--no-install')) {
    console.log(`  Installing with ${pm}…\n`);
    installed =
      spawnSync(pm, ['install'], {
        cwd: target,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      }).status === 0;
  }

  const run = pm === 'npm' ? 'npm run' : pm;
  console.log(`
  Next:
    cd ${/\s/.test(dir) ? `"${dir}"` : dir}${installed ? '' : `\n    ${pm} install`}
    ${run} dev

  Then open http://localhost:3000/book, or connect http://localhost:3000/mcp to Claude.
  Edit business.ts for your staff, services and opening hours.
`);
}

main().catch((e: unknown) => {
  console.error(`\n  ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
