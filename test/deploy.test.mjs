import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'aulas-deploy-'))
const appDir = join(root, 'app'), binDir = join(root, 'bin')
const callsFile = join(root, 'calls'), secretFile = join(root, 'student-token')
const token = 'c'.repeat(64)
const validMetadata = { apiVersion: 'v1', activePeriod: { code: '2026-2', displayName: '2/2026' }, dataVersion: 'd'.repeat(64), scheduleAvailable: false }
mkdirSync(join(appDir, 'deploy'), { recursive: true })
mkdirSync(join(appDir, 'data'))
mkdirSync(binDir)
writeFileSync(join(appDir, 'data', 'students.txt'), 'synthetic data')
writeFileSync(join(appDir, 'docker-compose.production.yml'), 'services: {}')

const source = readFileSync(new URL('../deploy/deploy.sh', import.meta.url), 'utf8')
writeFileSync(join(appDir, 'deploy', 'deploy.sh'), source
  .replace('/srv/apps/aulas-upds', appDir)
  .replace('/srv/secrets/portal/cupos-student-lookup-token', secretFile))

const executable = (name, contents) => {
  const path = join(binDir, name)
  writeFileSync(path, `#!/bin/sh\n${contents}`)
  chmodSync(path, 0o755)
}
executable('id', `case "$1" in -u) printf '%s\\n' "$MOCK_UID";; -g) printf '%s\\n' "$MOCK_GID";; esac`)
executable('docker', `
printf '%s|%s|%s\\n' "$RUNTIME_UID" "$RUNTIME_GID" "$*" >> "$CALLS_FILE"
case " $* " in
  *" network inspect "*) exit "$NETWORK_STATUS";;
  *" ps -q app "*) [ -z "$OLD_CONTAINER" ] || printf '%s\\n' "$OLD_CONTAINER";;
  *" inspect --format "*) printf '%s\\n' "$OLD_IMAGE";;
esac
exit 0`)
executable('curl', `
printf 'curl|%s\\n' "$*" >> "$CALLS_FILE"
case "$*" in *student-search/metadata*) printf '%s\\n%s' "$METADATA_BODY" "$METADATA_HTTP_STATUS"; exit "$METADATA_CURL_STATUS";; *) exit "$HEALTH_STATUS";; esac`)
executable('flock', 'exit 0')
executable('sleep', 'exit 0')
executable('stat', `case "$2" in %u) printf '%s\\n' "$SECRET_UID";; %a) printf '%s\\n' "$SECRET_MODE";; esac`)

after(() => rmSync(root, { recursive: true }))

const deploy = ({ uid = '1001', gid = '1001', networkStatus = '0', secret = 'valid', secretUid = uid, secretMode = '600', healthStatus = '0', metadataBody = validMetadata, metadataHttpStatus = '200', oldContainer = '', oldImage = '' } = {}) => {
  rmSync(callsFile, { force: true })
  rmSync(secretFile, { force: true })
  if (secret === 'symlink') symlinkSync(join(appDir, 'docker-compose.production.yml'), secretFile)
  else if (secret !== 'missing') writeFileSync(secretFile, secret === 'invalid' ? 'not-hex' : `${token}\n`)
  return spawnSync('bash', [join(appDir, 'deploy', 'deploy.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RELEASE_TAG: 'a'.repeat(40),
      MOCK_UID: uid,
      MOCK_GID: gid,
      NETWORK_STATUS: networkStatus,
      SECRET_UID: secretUid,
      SECRET_MODE: secretMode,
      HEALTH_STATUS: healthStatus,
      METADATA_CURL_STATUS: '0',
      METADATA_HTTP_STATUS: metadataHttpStatus,
      METADATA_BODY: JSON.stringify(metadataBody),
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
  assert.match(result.stdout, /Release a{40} is healthy and ready/)
  for (const operation of ['config -q', 'build --pull app', 'up -d --no-build --force-recreate app']) {
    assert.ok(calls().some((line) => line.startsWith('1001|1001|') && line.includes(operation)), operation)
  }
  assert.ok(calls().some((line) => line.includes('network inspect cupos-turmas_backend')))
  assert.ok(calls().some((line) => line.includes('/api/student-search/metadata')))
  assert.ok(calls().some((line) => line.includes("--write-out \\n%{http_code}")))
  assert.ok(calls().findIndex((line) => line.includes('network inspect')) < calls().findIndex((line) => line.includes('config -q')))
  assert.ok(calls().findIndex((line) => line.includes('/health')) < calls().findIndex((line) => line.includes('/api/student-search/metadata')))
  assert.doesNotMatch(`${result.stdout}${result.stderr}${calls().join('\n')}`, new RegExp(token))
})

test('rejects invalid or root operator IDs before invoking Docker', () => {
  for (const identity of [{ uid: 'invalid' }, { uid: '0' }, { gid: 'invalid' }, { gid: '0' }]) {
    const result = deploy(identity)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must be a nonzero number/)
    assert.throws(() => readFileSync(callsFile))
  }
})

test('rejects missing infrastructure and unsafe secrets before build', () => {
  for (const options of [
    { networkStatus: '1' }, { secret: 'missing' }, { secret: 'symlink' }, { secret: 'invalid' },
    { secretMode: '640' }, { secretMode: '200' }, { secretUid: '1002' },
  ]) {
    const result = deploy(options)
    assert.notEqual(result.status, 0)
    assert.ok(!calls().some((line) => line.includes('config -q')))
    assert.ok(!calls().some((line) => line.includes('build --pull app')))
    assert.doesNotMatch(`${result.stdout}${result.stderr}${calls().join('\n')}`, new RegExp(token))
  }
})

test('real metadata parser rejects schema drift and restores the TXT-compatible image', () => {
  const invalidMetadata = [
    { metadataBody: { ...validMetadata, activePeriod: { code: '2026-2' } } },
    { metadataBody: { ...validMetadata, extra: 'synthetic' } },
    { metadataBody: { ...validMetadata, activePeriod: { ...validMetadata.activePeriod, extra: 'synthetic' } } },
    { metadataHttpStatus: '201' },
  ]
  for (const metadata of invalidMetadata) {
    const result = deploy({ ...metadata, oldContainer: 'old-container', oldImage: 'old-image' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Readiness deadline exceeded/)
    assert.ok(calls().some((line) => line.includes('image tag old-image aulas-upds:')))
    assert.ok(calls().some((line) => line.endsWith('up -d --no-build app')))
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token))
  }
})
