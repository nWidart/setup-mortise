// The main step of the action: checks the input backfill, then runs setup.sh with bash, which
// installs mortise. The runner passes each input as INPUT_<NAME>, the names setup.sh reads.
// It uses only the modules of Node, so the action has no build step and no dependencies.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readBackfill } = require('./post.js');

// On Windows, the bash of Git for Windows, as `shell: bash` uses: the bash of System32 is WSL.
function bash() {
  if (process.platform !== 'win32') return 'bash';
  const git = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  return fs.existsSync(git) ? git : 'bash';
}

if (readBackfill(process.env.INPUT_BACKFILL) === undefined) {
  console.log(`::error::The input backfill is '${process.env.INPUT_BACKFILL}', not true or false.`);
  process.exit(1);
}

const run = spawnSync(bash(), [path.join(__dirname, 'setup.sh')], { stdio: 'inherit' });
if (run.error) {
  console.log(`::error::Could not run setup.sh with bash: ${run.error.message}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
