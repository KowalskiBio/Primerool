import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Sets up the Rust + React stack. The Primer3 reference crates
// (`primer3-sys`/`primer3-ffi`, test-only) are skipped so no C compiler is
// needed to get the app running.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(cmd, args, options = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('Fetching Rust dependencies and building the workspace ...');
run('cargo', ['build', '--workspace', '--exclude', 'primer3-sys', '--exclude', 'primer3-ffi']);

console.log('Installing frontend dependencies ...');
run('npm', ['install'], { cwd: path.join(root, 'frontend') });

console.log('\nSetup complete. Run `npm run dev` to start Primerool.');
