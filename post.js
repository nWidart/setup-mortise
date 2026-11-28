// The post step of the action: with backfill: true, it runs `mortise backfill <path>` after the
// steps of the job, so the push of HEAD arrives first. It runs only on a push to the default
// branch with MORTISE_TOKEN set; on every other run it prints nothing. It never fails the job.
//
// mortise reads MORTISE_TOKEN and MORTISE_CLOUD_URL from the environment of the step; the token is
// never on a command line and never printed here.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The first release that has `mortise backfill`.
const FIRST = [1, 3, 0];

// true or false for the values a boolean input takes, undefined for any other value.
function readBackfill(value) {
  const text = value ?? '';
  if (['true', 'True', 'TRUE'].includes(text)) return true;
  if (['', 'false', 'False', 'FALSE'].includes(text)) return false;
  return undefined;
}

function hasBackfill(version) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    const part = Number(parts[i + 1]);
    if (part !== FIRST[i]) return part > FIRST[i];
  }
  return true;
}

function defaultBranch(eventPath) {
  try {
    return JSON.parse(fs.readFileSync(eventPath, 'utf8')).repository?.default_branch;
  } catch {
    return undefined;
  }
}

// What the post step does with this environment: nothing, a warning, or a run of mortise.
function plan(env) {
  if (readBackfill(env.INPUT_BACKFILL) !== true) return { action: 'nothing' };
  if (env.GITHUB_EVENT_NAME !== 'push') return { action: 'nothing' };
  const branch = defaultBranch(env.GITHUB_EVENT_PATH);
  if (!branch || env.GITHUB_REF !== `refs/heads/${branch}`) return { action: 'nothing' };
  if (!env.MORTISE_TOKEN) return { action: 'nothing' };
  // The main step writes both when it installed mortise.
  if (!env.STATE_mortise || !env.STATE_version) return { action: 'nothing' };
  if (!hasBackfill(env.STATE_version)) {
    return {
      action: 'warn',
      message: `backfill needs Mortise 1.3.0 or later, and the job installed ${env.STATE_version}. No past commits were sent. Set the input version to latest or to v1.3.0 or later.`,
    };
  }
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  return {
    action: 'run',
    mortise: env.STATE_mortise,
    folder: path.resolve(workspace, env.INPUT_PATH || '.'),
    workspace,
  };
}

function run(env) {
  const step = plan(env);
  if (step.action === 'nothing') return;
  if (step.action === 'warn') {
    console.log(`::warning::${step.message}`);
    return;
  }
  const done = spawnSync(step.mortise, ['backfill', step.folder], {
    env,
    cwd: step.workspace,
    stdio: 'inherit',
  });
  let failure;
  if (done.error) failure = `could not start: ${done.error.message}`;
  else if (done.status !== 0) failure = done.signal ? `stopped by ${done.signal}` : `exited with code ${done.status}`;
  if (failure) {
    console.log(`::warning::mortise backfill ${failure}. No more past commits were sent; the job does not fail for it. The lines above say why.`);
  }
}

module.exports = { readBackfill, hasBackfill, plan, run };

if (require.main === module) {
  try {
    run(process.env);
  } catch (error) {
    console.log(`::warning::The backfill step of setup-mortise failed: ${error.message}. The job does not fail for it.`);
  }
  process.exit(0);
}
