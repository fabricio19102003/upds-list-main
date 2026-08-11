import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'release-wrapper-')), repo = join(root, 'repo'), bin = join(root, 'bin')
const releaseRoot = join(root, '.aulas-upds-releases'), sentinel = join(releaseRoot, 'pre-existing'), callsFile = join(root, 'calls')
const imageMark = join(root, 'image'), identity = join(root, 'identity'), sha = 'a'.repeat(40), secret = 'DO_NOT_PRINT_SYNTHETIC_SECRET'
mkdirSync(join(repo, 'deploy'), { recursive: true }); mkdirSync(bin); mkdirSync(releaseRoot, { mode: 0o700 }); chmodSync(releaseRoot, 0o700)
writeFileSync(sentinel, 'owned elsewhere'); writeFileSync(identity, secret)
const source = readFileSync(new URL('../deploy/release-production.sh', import.meta.url), 'utf8')
writeFileSync(join(repo, 'deploy', 'release-production.sh'), source)
chmodSync(join(repo, 'deploy', 'release-production.sh'), 0o755)
const mock = (name, body = 'exit 0') => {
  const file = join(bin, name)
  writeFileSync(file, `#!/bin/bash\nprintf '%s|%s\\n' '${name}' "$*" >> "$CALLS_FILE"\n${body}\n`); chmodSync(file, 0o755)
}
mock('git', `case "$*" in
  *'rev-parse --show-toplevel'*) printf '%s\\n' "$REPO";;
  *'status --porcelain'*) [[ "$SCENARIO" != main-status-fail || "$*" != *"-C $REPO status"* ]] || exit 11; [[ "$SCENARIO" != worktree-status-fail || "$*" == *"-C $REPO status"* ]] || exit 12; [[ "$SCENARIO" != dirty ]] || printf ' M file\\n';;
  *'rev-parse --verify HEAD'*) printf '%s\\n' "$SHA";;
  *'rev-parse --verify refs/remotes/origin/main'*) [[ "$SCENARIO" == diverged ]] && printf '%040d\\n' 1 || printf '%s\\n' "$SHA";;
  *'ls-remote origin refs/heads/main'*) printf '%s\\trefs/heads/main\\n' "$SHA";;
  *'worktree add'*) [[ "$SCENARIO" != worktree-add-fail ]] || exit 6; wt="\${@: -2:1}"; mkdir -p "$wt/deploy"; : > "$wt/docker-compose.production.yml";;
  *'rev-parse --is-inside-work-tree'*) printf 'true\\n';;
  *'symbolic-ref -q HEAD'*) exit 1;;
  *'rev-parse HEAD'*) printf '%s\\n' "$SHA";;
  *'ls-files --stage -z'*) [[ "$SCENARIO" != ls-files-fail ]] || exit 7; [[ "$SCENARIO" != signal-hup ]] || { kill -HUP "$PPID"; exit; }; [[ "$SCENARIO" != signal-term ]] || { kill -TERM "$PPID"; exit; }; [[ "$SCENARIO" != signal-int ]] || { kill -INT "$PPID"; exit; };;
  *'worktree remove'*) [[ "$SCENARIO" != cleanup-remove-fail ]] || exit 8; rm -rf "\${@: -1}";;
esac`)
mock('npm'); mock('trivy'); mock('rsync'); mock('sha256sum')
mock('docker', `case "$*" in
  *'image ls --quiet --no-trunc --filter reference=aulas-upds:'*) [[ "$SCENARIO" != docker-query-fail ]] || exit 13; [[ "$SCENARIO" != image-exists ]] || printf 'sha256:%064d\\n' 0; [[ "$SCENARIO" != docker-ambiguous ]] || printf 'unexpected output\\n'; exit 0;;
  *'image inspect aulas-upds:'*) [[ "$SCENARIO" == image-exists || -f "$IMAGE_MARK" ]];;
  *' build app') touch "$IMAGE_MARK";;
  *'image rm aulas-upds:'*) rm -f "$IMAGE_MARK";;
esac`)
mock('ssh', `case "$*" in
  *sha256sum*) h=$(printf '%064d' 0 | tr 0 a); active=$h; [[ "$SCENARIO" != nginx-mismatch ]] || active=$(printf '%064d' 0 | tr 0 b); staged_path=/srv/apps/aulas-upds/deploy/nginx/aulas-upds.conf; active_path=/etc/nginx/sites-enabled/aulas-upds.conf; label=STAGED; [[ "$SCENARIO" != nginx-wrong-path ]] || staged_path=/unrelated/aulas-upds.conf; [[ "$SCENARIO" != nginx-wrong-active ]] || active_path=/unrelated/active.conf; [[ "$SCENARIO" != nginx-wrong-label ]] || label=SOURCE; printf '%s %s  %s\\nACTIVE %s  %s\\n' "$label" "$h" "$staged_path" "$active" "$active_path"; [[ "$SCENARIO" != nginx-extra ]] || printf 'EXTRA %s\\n' "$h";;
  *'RELEASE_TAG='*) [[ "$SCENARIO" != deploy-fail ]] || exit 9;;
  *'bash -s --'*) printf 'APP_EXACT=1 CUPOS_HEALTHY=2/2\\n';;
esac`)
mock('curl', `out=''; dump=''; url="\${!#}"; while (( $# )); do case $1 in --output) out=$2; shift;; --dump-header) dump=$2; shift;; esac; shift; done
[[ -z "$dump" ]] || printf 'HTTP/2 200\\nContent-Security-Policy: default-src self\\nPermissions-Policy: camera=()\\nReferrer-Policy: no-referrer\\nStrict-Transport-Security: max-age=31536000\\nX-Content-Type-Options: nosniff\\nX-Frame-Options: DENY\\n' > "$dump"
case "$url" in http://*) printf '301 https://aulas.upds-cobija.cloud/';; */metadata) [[ "$SCENARIO" != metadata-invalid ]] || { printf '{"results":[]}' > "$out"; printf 200; exit; }; printf '{"apiVersion":"v1","activePeriod":{"code":"2026-2","displayName":"2/2026"},"dataVersion":"%064d","scheduleAvailable":false}' 0 > "$out"; printf 200;; */api/student-search) [[ "$SCENARIO" != search-invalid ]] || { printf '{"error":"raw"}' > "$out"; printf 400; exit; }; printf '{"error":{"code":"invalid_request","message":"Invalid request."}}' > "$out"; printf 400;; */api/search) printf 404;; *) printf 200;; esac`)

after(() => rmSync(root, { recursive: true }))
const run = (scenario = 'success', input = `${sha}\n`, dry = false) => {
  rmSync(callsFile, { force: true }); rmSync(imageMark, { force: true })
  const result = spawnSync('bash', [join(repo, 'deploy', 'release-production.sh'), ...(dry ? ['--dry-run'] : [])], {
    encoding: 'utf8', input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_IDENTITY: identity, CALLS_FILE: callsFile, IMAGE_MARK: imageMark, REPO: repo, SHA: sha, SCENARIO: scenario },
  })
  const calls = readFileSync(callsFile, 'utf8'), added = calls.match(/git\|.*worktree add --quiet --detach (\S+) /)
  assert.doesNotMatch(`${result.stdout}${result.stderr}${calls}`, new RegExp(secret)); assert.equal(existsSync(sentinel), true)
  if (added) assert.equal(existsSync(dirname(added[1])), false, 'owned container must be removed')
  return { result, calls }
}
const noRsync = ({ result, calls }) => { assert.notEqual(result.status, 0); assert.doesNotMatch(calls, /^rsync\|/m) }

test('dirty, diverged, and unconfirmed releases stop before rsync', () => {
  for (const [scenario, input] of [['dirty', `${sha}\n`], ['diverged', `${sha}\n`], ['success', 'wrong\n']]) noRsync(run(scenario, input))
})

test('main and release worktree git status failures propagate before gates', () => {
  for (const scenario of ['main-status-fail', 'worktree-status-fail']) {
    const failed = run(scenario); noRsync(failed); assert.doesNotMatch(failed.calls, /^npm\|/m)
    if (scenario === 'main-status-fail') assert.doesNotMatch(failed.calls, /worktree add/)
  }
  assert.doesNotMatch(source, /\[\[ -z \$\(git .*status/)
})

test('worktree-add and ls-files failures propagate with owned-only cleanup', () => {
  for (const scenario of ['worktree-add-fail', 'ls-files-fail']) {
    const failed = run(scenario); noRsync(failed); assert.doesNotMatch(failed.calls, /^npm\|/m)
    if (scenario === 'worktree-add-fail') assert.doesNotMatch(failed.calls, /worktree remove/)
  }
})

test('dry-run certifies locally, opens rsync SSH without mutation, and cleans only owned artifacts', () => {
  const { result, calls } = run('cleanup-remove-fail', `${sha}\n`, true)
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /opened SSH\/remote rsync/); assert.match(calls, /^rsync\|.*--dry-run/m)
  assert.doesNotMatch(calls, /^ssh\|/m); assert.match(calls, /-i .*identity/); assert.doesNotMatch(calls, /(^| )-F( |$)|--delete|id_rsa/)
  assert.match(source, /\.ssh\/upds_vps_20260810/); assert.doesNotMatch(source, /rmdir|ssh -F/)
  for (const gate of ['npm|ci', 'npm|test', 'npm|run lint', 'npm|run build', 'npm|audit --audit-level=low', 'trivy|image']) assert.ok(calls.includes(gate), gate)
  const exclusions = ['.git/', '.codegraph/', '.env*', 'node_modules/', 'dist/', 'src/data/', 'data/', 'test-results/', 'playwright-report/', '*[Ss]ecret*', '*[Tt]oken*', '*[Cc]redential*', '*.key', '*.pem', '*.db', '*.db-*', '*.sqlite*', '*.sql', '*.dump', '*.xls*', '*.ods', '*[Ww]orkbook*', '*.log', 'coverage/', 'tmp/', 'temp/', '*.tmp', '.cache/', '.npm/', '.vite/', '__pycache__/', '*.py[co]']
  for (const value of exclusions) assert.ok(calls.includes(`--exclude ${value}`), value)
  assert.equal((calls.match(/--exclude /g) || []).length, exclusions.length); assert.match(calls, /docker\|image rm aulas-upds:/)
})

test('Docker exact-tag query distinguishes absent, present, and operational failure', () => {
  for (const scenario of ['image-exists', 'docker-query-fail', 'docker-ambiguous']) {
    const { result, calls } = run(scenario); assert.notEqual(result.status, 0)
    assert.match(calls, /docker\|image ls --quiet --no-trunc --filter reference=aulas-upds:/); assert.doesNotMatch(calls, /docker\|.* build app|docker\|image rm/)
  }
  const absent = run('cleanup-remove-fail', `${sha}\n`, true); assert.equal(absent.result.status, 0, absent.result.stderr); assert.match(absent.calls, /docker\|.* build app/)
})

test('HUP, TERM, and INT preserve conventional nonzero exits and owned cleanup', () => {
  for (const [scenario, code] of [['signal-hup', 129], ['signal-term', 143], ['signal-int', 130]]) {
    const { result, calls } = run(scenario); assert.equal(result.status, code, `${result.stderr}\n${calls}`); assert.match(calls, /git\|.*worktree remove --force/)
    assert.doesNotMatch(calls, /^npm\||^rsync\|/m)
  }
  assert.match(source, /trap 'exit 129' HUP[\s\S]*trap 'exit 130' INT[\s\S]*trap 'exit 143' TERM/)
})

test('Nginx evidence requires exact labels, paths, two lines, and matching hashes', () => {
  for (const scenario of ['nginx-mismatch', 'nginx-wrong-path', 'nginx-wrong-active', 'nginx-wrong-label', 'nginx-extra']) {
    const { result, calls } = run(scenario); assert.notEqual(result.status, 0); assert.doesNotMatch(calls, /ssh\|.*RELEASE_TAG=/)
    if (scenario === 'nginx-mismatch') assert.match(result.stdout, /sudo install[\s\S]*sudo nginx -t[\s\S]*sudo systemctl reload nginx/)
  }
})

test('unsafe metadata and an unsanitized invalid-search response fail closed', () => {
  for (const scenario of ['metadata-invalid', 'search-invalid']) {
    const { result, calls } = run(scenario); assert.notEqual(result.status, 0); assert.equal((calls.match(/ssh\|.*RELEASE_TAG=/g) || []).length, 1)
    assert.doesNotMatch(calls, /ssh\|.*bash -s --/)
  }
})

test('deploy runs once at exact SHA, never retries, and uses only safe public probes', () => {
  for (const scenario of ['success', 'deploy-fail']) {
    const { result, calls } = run(scenario), deploys = calls.split('\n').filter((line) => line.startsWith('ssh|') && line.includes('RELEASE_TAG='))
    assert.equal(deploys.length, 1); assert.match(deploys[0], new RegExp(`RELEASE_TAG=${sha} bash /srv/apps/aulas-upds/deploy/deploy.sh$`))
    assert.equal(result.status === 0, scenario === 'success', `${scenario}: ${result.stderr}`)
    if (scenario === 'success') { assert.match(calls, /curl\|.*\/api\/student-search\/metadata/); assert.match(calls, /curl\|.*--data \{"mode":"name","query":"x"\}/); assert.doesNotMatch(calls, /zz-release/) }
  }
})
