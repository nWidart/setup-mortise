// Tests of the post step: `node --test tests/`.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readBackfill, hasBackfill, plan, run } = require('../post.js');

const post = path.join(__dirname, '..', 'post.js');

function folder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'setup-mortise-test-'));
}

// The environment of a post step that runs the backfill; each test changes one thing.
function pushRun(extra = {}, payload = {}) {
  const dir = folder();
  const event = path.join(dir, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ repository: { default_branch: 'main' }, ...payload }));
  return {
    INPUT_BACKFILL: 'true',
    INPUT_PATH: '.',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_EVENT_PATH: event,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKSPACE: dir,
    MORTISE_TOKEN: 'mrt_secret_value',
    STATE_mortise: path.join(dir, 'mortise'),
    STATE_version: 'v1.3.0',
    ...extra,
  };
}

// Runs post.js as the runner does and gives what it printed.
function runPost(env) {
  return spawnSync(process.execPath, [post], { env, encoding: 'utf8' });
}

test('backfill takes the values of a boolean input', () => {
  for (const value of ['true', 'True', 'TRUE']) assert.equal(readBackfill(value), true);
  for (const value of [undefined, '', 'false', 'False', 'FALSE']) assert.equal(readBackfill(value), false);
  for (const value of ['yes', '1', 'on', 'tru']) assert.equal(readBackfill(value), undefined);
});

test('backfill exists from Mortise 1.3.0', () => {
  for (const version of ['v1.3.0', '1.3.0', 'v1.3.1', 'v1.10.0', 'v2.0.0']) assert.equal(hasBackfill(version), true, version);
  for (const version of ['v1.2.0', 'v1.2.9', 'v0.9.9', 'v0.30.0', '', undefined]) assert.equal(hasBackfill(version), false, version);
});

test('the post step does nothing on every other run', () => {
  const cases = {
    'backfill not set': { INPUT_BACKFILL: undefined },
    'backfill false': { INPUT_BACKFILL: 'false' },
    'a pull request': { GITHUB_EVENT_NAME: 'pull_request' },
    'a schedule': { GITHUB_EVENT_NAME: 'schedule' },
    'another branch': { GITHUB_REF: 'refs/heads/feature' },
    'a tag': { GITHUB_REF: 'refs/tags/main' },
    'a branch that differs in case': { GITHUB_REF: 'refs/heads/Main' },
    'no token': { MORTISE_TOKEN: undefined },
    'an empty token': { MORTISE_TOKEN: '' },
    'no event file': { GITHUB_EVENT_PATH: path.join(os.tmpdir(), 'setup-mortise-no-such-event.json') },
    'no install by the main step': { STATE_mortise: undefined, STATE_version: undefined },
  };
  const payloads = { 'a push that deleted a branch': { deleted: true } };
  for (const [name, payload] of Object.entries(payloads)) {
    const env = pushRun({}, payload);
    assert.deepEqual(plan(env), { action: 'nothing' }, name);
    const printed = runPost(env);
    assert.equal(printed.status, 0, name);
    assert.equal(printed.stdout + printed.stderr, '', name);
  }
  for (const [name, extra] of Object.entries(cases)) {
    const env = pushRun(extra);
    for (const key of Object.keys(extra)) if (extra[key] === undefined) delete env[key];
    assert.deepEqual(plan(env), { action: 'nothing' }, name);
    const printed = runPost(env);
    assert.equal(printed.status, 0, name);
    assert.equal(printed.stdout + printed.stderr, '', name);
  }
});

test('a release without backfill gives one warning and runs nothing', () => {
  const env = pushRun({ STATE_version: 'v1.2.0' });
  const step = plan(env);
  assert.equal(step.action, 'warn');
  assert.match(step.message, /1\.3\.0 or later.*v1\.2\.0/);
  const printed = runPost(env);
  assert.equal(printed.status, 0);
  assert.equal(printed.stdout.trim().split('\n').length, 1);
  assert.match(printed.stdout, /^::warning::/);
});

test('path is read against the workspace', () => {
  const env = pushRun();
  const workspace = env.GITHUB_WORKSPACE;
  assert.equal(plan(env).folder, path.resolve(workspace));
  assert.equal(plan({ ...env, INPUT_PATH: 'apps/shop' }).folder, path.join(workspace, 'apps', 'shop'));
  assert.equal(plan({ ...env, INPUT_PATH: '' }).folder, path.resolve(workspace));
  const absolute = path.resolve(os.tmpdir(), 'elsewhere');
  assert.equal(plan({ ...env, INPUT_PATH: absolute }).folder, absolute);
});

// A fake mortise: a shell script, so these tests skip on Windows. CI runs the real binary there.
const posix = { skip: process.platform === 'win32' && 'needs a shell script as mortise' };

function fakeMortise(env, exit) {
  const out = path.join(env.GITHUB_WORKSPACE, 'called.txt');
  fs.writeFileSync(
    env.STATE_mortise,
    `#!/bin/sh\nprintf '%s\\n' "$1" "$2" "$PWD" "$MORTISE_TOKEN" "$MORTISE_CLOUD_URL" > '${out}'\nexit ${exit}\n`,
    { mode: 0o755 },
  );
  return out;
}

test('the post step runs the installed mortise, whatever PATH and the working directory are', posix, () => {
  const env = pushRun({ INPUT_PATH: 'app', PATH: '/nowhere', MORTISE_CLOUD_URL: 'https://cloud.test' });
  fs.mkdirSync(path.join(env.GITHUB_WORKSPACE, 'app'));
  const called = fakeMortise(env, 0);
  const printed = spawnSync(process.execPath, [post], { env, encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(printed.status, 0);
  assert.equal(printed.stdout, '');
  const [command, target, cwd, token, url] = fs.readFileSync(called, 'utf8').split('\n');
  assert.equal(command, 'backfill');
  assert.equal(target, path.join(env.GITHUB_WORKSPACE, 'app'));
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(env.GITHUB_WORKSPACE));
  assert.equal(token, 'mrt_secret_value');
  assert.equal(url, 'https://cloud.test');
});

test('a failed backfill warns and never fails the job', posix, () => {
  for (const exit of [1, 2, 4]) {
    const env = pushRun();
    fakeMortise(env, exit);
    const printed = runPost(env);
    assert.equal(printed.status, 0, `exit ${exit}`);
    assert.match(printed.stdout, new RegExp(`^::warning::mortise backfill exited with code ${exit}\\.`), `exit ${exit}`);
    assert.doesNotMatch(printed.stdout + printed.stderr, /mrt_secret_value/);
  }
});

test('a mortise that cannot start warns and never fails the job', () => {
  const env = pushRun();
  const printed = runPost(env);
  assert.equal(printed.status, 0);
  assert.match(printed.stdout, /^::warning::mortise backfill could not start/);
});

test('run prints nothing and runs nothing on a pull request', () => {
  const env = pushRun({ GITHUB_EVENT_NAME: 'pull_request' });
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  try {
    run(env);
  } finally {
    console.log = log;
  }
  assert.deepEqual(logged, []);
});

test('the main step refuses a backfill that is not true or false', () => {
  const main = path.join(__dirname, '..', 'main.js');
  for (const value of ['yes', 'yes\n::set-output name=version::v9.9.9']) {
    const printed = spawnSync(process.execPath, [main], { env: { ...process.env, INPUT_BACKFILL: value }, encoding: 'utf8' });
    assert.equal(printed.status, 1);
    assert.equal(printed.stdout, '::error::The input backfill must be true or false.\n');
  }
});

test('the post step runs unless the job was cancelled', () => {
  const action = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
  const lines = action.split('\n').filter((line) => /^\s*post-if:/.test(line));
  assert.deepEqual(lines, ["  post-if: '!cancelled()'"]);
});

// The main step with a fake release served from file://, as Linux on x64 names it. Gives the exit
// code and what it wrote to GITHUB_STATE.
function mainStep(release) {
  const dir = folder();
  const temp = path.join(dir, 'temp');
  fs.mkdirSync(temp);
  for (const file of ['state', 'output', 'path']) fs.writeFileSync(path.join(dir, file), '');
  const env = {
    PATH: process.env.PATH,
    INPUT_VERSION: 'v1.3.0',
    INPUT_BACKFILL: 'true',
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    RUNNER_TEMP: temp,
    GITHUB_STATE: path.join(dir, 'state'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
    GITHUB_PATH: path.join(dir, 'path'),
    SETUP_MORTISE_BASE_URL: `file://${dir}/release`,
  };
  if (release) release(path.join(dir, 'release', 'v1.3.0'), dir);
  const done = spawnSync(process.execPath, [path.join(__dirname, '..', 'main.js')], { env, encoding: 'utf8' });
  return { status: done.status, state: fs.readFileSync(env.GITHUB_STATE, 'utf8') };
}

// A release whose archive holds a mortise that prints `printed` for --version, with a right sum.
function release(printed) {
  return (folder, dir) => {
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(stage);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(stage, 'mortise'), `#!/bin/sh\necho '${printed}'\n`, { mode: 0o755 });
    const archive = 'mortise-v1.3.0-linux-x86_64.tar.gz';
    const packed = spawnSync('tar', ['-czf', path.join(folder, archive), '-C', stage, 'mortise']);
    assert.equal(packed.status, 0);
    const sum = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(folder, archive))).digest('hex');
    fs.writeFileSync(path.join(folder, 'Mortise-v1.3.0-SHA256SUMS.txt'), `${sum}  ${archive}\n`);
  };
}

test('a main step that fails half way writes no state, so the post step does nothing', posix, () => {
  const cases = {
    'no release': undefined,
    'a binary that prints another version': release('mortise 9.9.9'),
  };
  for (const [name, made] of Object.entries(cases)) {
    const main = mainStep(made);
    assert.equal(main.status, 1, name);
    assert.equal(main.state, '', name);
    const env = pushRun();
    delete env.STATE_mortise;
    delete env.STATE_version;
    const printed = runPost({ ...env, ...stateOf(main.state) });
    assert.equal(printed.status, 0, name);
    assert.equal(printed.stdout + printed.stderr, '', name);
  }
  // The same release with the right version installs and writes the state the post step reads.
  const main = mainStep(release('mortise 1.3.0'));
  assert.equal(main.status, 0);
  assert.match(main.state, /^mortise=.*\nversion=v1\.3\.0\n$/);
  const state = stateOf(main.state);
  assert.equal(plan({ ...pushRun(), ...state }).mortise, state.STATE_mortise);
});

// The environment the runner gives the post step for the lines of GITHUB_STATE.
function stateOf(text) {
  const env = {};
  for (const line of text.split('\n').filter(Boolean)) {
    const at = line.indexOf('=');
    env[`STATE_${line.slice(0, at)}`] = line.slice(at + 1);
  }
  return env;
}
