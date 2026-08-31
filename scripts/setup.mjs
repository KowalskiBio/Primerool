import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Sets up the Rust + React stack (replaces the old Python venv + vanilla-JS
// setup now that Phase 6 has shipped). `backend/` (the original Flask app)
// is kept around as a reference but is no longer part of the active dev
// workflow, so it's not provisioned here.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function run(cmd, args, options = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('Fetching Rust dependencies and building the workspace ...');
run('cargo', ['build', '--workspace']);

console.log('Installing frontend dependencies ...');
run('npm', ['install'], { cwd: path.join(root, 'frontend') });

console.log('\nSetup complete. Run `npm run dev` to start Primerool.');
