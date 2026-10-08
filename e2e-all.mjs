// One-command E2E: boots wrangler dev, runs suites, kills dev.
// Usage: node e2e-all.mjs [port]
//   SUITES env picks suites (default: match,match-bj,liars-normal).
//   Full sweep: SUITES=match,match-bj,liars-normal,liars-devil,blackjack,resume,resume-bj
// Windows dev loop: starts/stops the server around the run.
import { spawn, execFileSync } from 'node:child_process';

const PORT = Number(process.argv[2] || 9287);
const BASE = `http://localhost:${PORT}`;
const SUITES = (process.env.SUITES || 'match,match-bj,liars-normal').split(',').map((s) => s.trim()).filter(Boolean);

const JOBS = {
  'match': { cmd: ['node', 'e2e-match.mjs'], env: {} },
  'match-bj': { cmd: ['node', 'e2e-match.mjs'], env: { MATCH_MODE: 'blackjack' } },
  'liars-normal': { cmd: ['node', 'e2e-liars.mjs', 'normal'], env: {} },
  'liars-devil': { cmd: ['node', 'e2e-liars.mjs', 'devil'], env: { CP: '1.0' } },
  'blackjack': { cmd: ['node', 'e2e-blackjack.mjs'], env: {} },
  'resume': { cmd: ['node', 'e2e-resume.mjs'], env: {} },
  'resume-bj': { cmd: ['node', 'e2e-resume-bj.mjs'], env: {} },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {}
    await sleep(5000);
  }
  return false;
}

const dev = spawn('cmd.exe', ['/c', 'npx', 'wrangler', 'dev', '--port', String(PORT)], {
  cwd: process.cwd(), stdio: 'ignore',
});
let failed = [];
try {
  console.log(`[all] booting wrangler dev on ${PORT}…`);
  if (!(await waitReady())) {
    console.log('[all] dev server never came up');
    process.exitCode = 1;
  } else {
    for (const name of SUITES) {
      const job = JOBS[name];
      if (!job) { console.log(`[all] unknown suite ${name}`); failed.push(name); continue; }
      console.log(`[all] --- ${name} ---`);
      try {
        execFileSync(process.execPath, job.cmd.slice(1), {
          cwd: process.cwd(),
          env: { ...process.env, E2E_BASE: BASE, ...job.env },
          stdio: 'inherit',
          timeout: 280000,
        });
      } catch {
        failed.push(name);
      }
    }
  }
} finally {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/PID', String(dev.pid), '/T'], { stdio: 'ignore' });
    } else {
      dev.kill('SIGKILL');
    }
  } catch {}
}

if (failed.length) {
  console.log(`[all] FAIL: ${failed.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('[all] ALL GREEN');
}
