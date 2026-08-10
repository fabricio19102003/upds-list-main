import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'aulas-deploy-'))
const appDir = join(root, 'app'), binDir = join(root, 'bin')
const callsFile = join(root, 'calls')
mkdirSync(join(appDir, 'deploy'), { recursive: true })
mkdirSync(join(appDir, 'data'))
mkdirSync(binDir)
writeFileSync(join(appDir, 'data', 'students.txt'), 'synthetic data')
writeFileSync(join(appDir, 'docker-compose.production.yml'), 'services: {}')

const source = readFileSync(new URL('../deploy/deploy.sh', import.meta.url), 'utf8')
writeFileSync(join(appDir, 'deploy', 'deploy.sh'), source.replace('/srv/apps/aulas-upds', appDir))

const executable = (name, contents) => {
  const path = join(binDir, name)
  writeFileSync(path, `#!/bin/sh\n${contents}`)
  chmodSync(path, 0o755)
}
executable('id', `case "$1" in -u) printf '%s\\n' "$MOCK_UID";; -g) printf '%s\\n' "$MOCK_GID";; esac`)
executable('docker', `
printf '%s|%s|%s\\n' "$RUNTIME_UID" "$RUNTIME_GID" "$*" >> "$CALLS_FILE"
case " $* " in
  *" ps -q app "*) [ -z "$OLD_CONTAINER" ] || printf '%s\\n' "$OLD_CONTAINER";;
  *" inspect --format "*) printf '%s\\n' "$OLD_IMAGE";;
esac
exit 0`)
executable('curl', 'exit "${CURL_STATUS:-0}"')
executable('flock', 'exit 0')
executable('sleep', 'exit 0')

after(() => rmSync(root, { recursive: true }))

const deploy = ({ uid = '1001', gid = '1001', curlStatus = '0', oldContainer = '', oldImage = '' } = {}) => {
  rmSync(callsFile, { force: true })
  return spawnSync('bash', [join(appDir, 'deploy', 'deploy.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RELEASE_TAG: 'a'.repeat(40),
      MOCK_UID: uid,
      MOCK_GID: gid,
      CURL_STATUS: curlStatus,
      OLD_CONTAINER: oldContainer,
      OLD_IMAGE: oldImage,
      CALLS_FILE: callsFile,
    },
  })
}

const calls = () => readFileSync(callsFile, 'utf8').trim().split('\n')

test('exports the deployment operator IDs before Compose config, build, and up', () => {
  const result = deploy()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Release a{40} is healthy/)
  for (const operation of ['config -q', 'build --pull app', 'up -d --no-build app']) {
    assert.ok(calls().some((line) => line.startsWith('1001|1001|') && line.includes(operation)), operation)
  }
})

test('rejects invalid or root operator IDs before invoking Docker', () => {
  for (const identity of [{ uid: 'invalid' }, { uid: '0' }, { gid: 'invalid' }, { gid: '0' }]) {
    const result = deploy(identity)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must be a nonzero number/)
    assert.throws(() => readFileSync(callsFile))
  }
})

test('preserves exported IDs through rollback after a failed rollout', () => {
  const result = deploy({ curlStatus: '1' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Health deadline exceeded/)
  assert.ok(calls().some((line) => line === '1001|1001|compose -f ' + join(appDir, 'docker-compose.production.yml') + ' rm -s -f app'))
})
