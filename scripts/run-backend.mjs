import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the real Rust backend (`crates/server`'s standalone binary) —
// replaces the old Python/Flask dev_server.py entry point now that the
// rewrite's Phase 6 has a working axum server + React frontend. `cargo run`
// picks up incremental builds automatically, same DX as before.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const child = spawn('cargo', ['run', '-p', 'server'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PRIMEROOL_ADDR: process.env.PRIMEROOL_ADDR || '127.0.0.1:5050' },
});

child.on('exit', (code) => process.exit(code ?? 0));
