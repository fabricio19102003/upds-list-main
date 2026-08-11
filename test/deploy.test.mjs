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
  *" ps -q app "*) if /usr/bin/grep -q force-recreate "$CALLS_FILE"; then printf '%s\\n' "$CANDIDATE_CONTAINER"; exit "$CANDIDATE_PS_STATUS"; elif [ -n "$OLD_CONTAINER" ]; then printf '%s\\n' "$OLD_CONTAINER"; fi;;
  *" inspect --format "*) case "$*" in
    *".State.Health.Status"*) printf '%s\\n' "$DOCKER_HEALTH";;
    *".RestartCount"*) printf '%s\\n' "$RESTART_COUNT";;
    *".State.Health.Log"*) printf '%s\\n' "$HEALTH_EXIT_CODES";;
    *".Image"*) if [ -n "$CANDIDATE_CONTAINER" ]; then case "$*" in *"$CANDIDATE_CONTAINER"*) printf '%s\\n' "$CANDIDATE_IMAGE"; exit "$CANDIDATE_IMAGE_STATUS";; esac; fi; printf '%s\\n' "$OLD_IMAGE";;
  esac;;
  *" logs --tail 200 "*) printf '%s' "$STARTUP_LOGS"; exit "$LOGS_STATUS";;
esac
exit 0`)
executable('curl', `
printf 'curl|%s\\n' "$*" >> "$CALLS_FILE"
case "$*" in *student-search/metadata*) printf '%s\\n%s' "$METADATA_BODY" "$METADATA_HTTP_STATUS"; exit "$METADATA_CURL_STATUS";; *) printf '%s' "$HEALTH_HTTP_STATUS"; exit "$HEALTH_CURL_STATUS";; esac`)
executable('flock', 'exit 0')
executable('sleep', 'exit 0')
executable('stat', `case "$2" in %u) printf '%s\\n' "$SECRET_UID";; %a) printf '%s\\n' "$SECRET_MODE";; esac`)

after(() => rmSync(root, { recursive: true }))

const deploy = ({ uid = '1001', gid = '1001', networkStatus = '0', secret = 'valid', secretUid = uid, secretMode = '600', healthCurlStatus = '0', healthHttpStatus = '200', metadataCurlStatus = '0', metadataBody = validMetadata, metadataHttpStatus = '200', oldContainer = '', oldImage = '', candidatePsStatus = '0', candidateContainer = '1234567890abcdef', candidateImageStatus = '0', candidateImage = `sha256:${'1'.repeat(64)}`, dockerHealth = 'unhealthy', restartCount = '3', healthExitCodes = '1,137,', logsStatus = '0', startupLogs = '' } = {}) => {
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
      HEALTH_CURL_STATUS: healthCurlStatus,
      HEALTH_HTTP_STATUS: healthHttpStatus,
      METADATA_CURL_STATUS: metadataCurlStatus,
      METADATA_HTTP_STATUS: metadataHttpStatus,
      METADATA_BODY: typeof metadataBody === 'string' ? metadataBody : JSON.stringify(metadataBody),
      OLD_CONTAINER: oldContainer,
      OLD_IMAGE: oldImage,
      CANDIDATE_PS_STATUS: candidatePsStatus,
      CANDIDATE_CONTAINER: candidateContainer,
      CANDIDATE_IMAGE_STATUS: candidateImageStatus,
      CANDIDATE_IMAGE: candidateImage,
      DOCKER_HEALTH: dockerHealth,
      RESTART_COUNT: restartCount,
      HEALTH_EXIT_CODES: healthExitCodes,
      LOGS_STATUS: logsStatus,
      STARTUP_LOGS: startupLogs,
      CALLS_FILE: callsFile,
    },
  })
}

const calls = () => readFileSync(callsFile, 'utf8').trim().split('\n')
const assertExactRollback = (result) => {
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(result.stdout, /healthy and ready/)
  const tag = calls().findIndex((line) => line.includes('image tag old-image aulas-upds:'))
  assert.ok(tag >= 0, `${result.stderr}\n${calls().join('\n')}`)
  assert.equal(calls().filter((line) => line.endsWith('up -d --no-build app')).length, 1)
  assert.ok(tag < calls().findIndex((line, index) => index > tag && line.endsWith('up -d --no-build app')))
}

test('exports the deployment operator IDs before Compose config, build, and up', () => {
  const result = deploy()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Release a{40} is healthy and ready/)
  for (const operation of ['config -q', 'build --pull app', 'up -d --no-build --force-recreate app']) {
    assert.ok(calls().some((line) => line.startsWith('1001|1001|') && line.includes(operation)), operation)
  }
  assert.ok(calls().some((line) => line.includes('network inspect cupos-turmas_backend')))
  assert.ok(calls().some((line) => line.includes('/api/student-search/metadata')))
  assert.ok(calls().some((line) => line.includes('%{http_code}')))
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

test('categorizes every readiness failure with the real metadata parser', () => {
  const failures = [
    [{ healthCurlStatus: '7' }, 'health-transport'],
    [{ healthHttpStatus: '503' }, 'health-http'],
    [{ metadataCurlStatus: '28' }, 'metadata-transport'],
    [{ metadataHttpStatus: '503' }, 'metadata-http'],
    [{ metadataBody: '{invalid' }, 'metadata-invalid-json'],
    [{ metadataBody: { ...validMetadata, extra: 'synthetic' } }, 'metadata-schema'],
    [{ metadataBody: { ...validMetadata, activePeriod: { code: '2026-3', displayName: '3/2026' } } }, 'metadata-period'],
  ]
  for (const [options, category] of failures) {
    const result = deploy({ ...options, oldContainer: 'old-container', oldImage: 'old-image' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(`attempts=30 last=${category}`))
    assert.ok(calls().some((line) => line.includes('image tag old-image aulas-upds:')))
    assert.ok(calls().some((line) => line.endsWith('up -d --no-build app')))
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token))
  }
})

test('fails closed when candidate discovery is unsuccessful or ambiguous', () => {
  const otherContainer = 'fedcba0987654321'
  const failures = [
    [{ candidatePsStatus: '1' }, 'candidate-ps'],
    [{ candidateContainer: '' }, 'candidate-container'],
    [{ candidateContainer: `1234567890abcdef\n${otherContainer}` }, 'candidate-container'],
    [{ candidateContainer: 'not-a-container' }, 'candidate-container'],
    [{ candidateImageStatus: '1' }, 'candidate-image-inspect'],
    [{ candidateImage: 'sha256:not-an-image' }, 'candidate-image'],
  ]
  for (const [options, category] of failures) {
    const result = deploy({ ...options, oldContainer: 'old-container', oldImage: 'old-image' })
    assertExactRollback(result)
    assert.match(result.stderr, new RegExp(`attempts=0 last=${category}`))
    assert.ok(!calls().some((line) => line.startsWith('curl|')))
    assert.doesNotMatch(result.stderr, /not-a-container|fedcba0987654321|not-an-image/)
  }
})

test('reports failed startup-log capture as unavailable', () => {
  const result = deploy({ healthHttpStatus: '503', logsStatus: '1', startupLogs: 'sensitive raw output', oldContainer: 'old-container', oldImage: 'old-image' })
  assertExactRollback(result)
  assert.match(result.stderr, /logs=unavailable startup_lines=unavailable startup_classes=unavailable/)
  assert.doesNotMatch(result.stderr, /startup_lines=0|sensitive raw output/)
})

test('bounds malformed and oversized restart counters', () => {
  for (const [restartCount, expected] of [['malformed-sensitive', 'invalid'], ['9'.repeat(50_000), 'capped']]) {
    const result = deploy({ healthHttpStatus: '503', restartCount, oldContainer: 'old-container', oldImage: 'old-image' })
    assertExactRollback(result)
    assert.match(result.stderr, new RegExp(`restarts=${expected}`))
    assert.ok(result.stderr.length < 1000)
    assert.doesNotMatch(result.stderr, /malformed-sensitive|9{20}/)
  }
})

test('prints bounded redacted candidate evidence before exact rollback', () => {
  const pii = 'Student Jane Doe document 99887766 query results'
  const leakedHash = 'e'.repeat(64)
  const result = deploy({
    metadataBody: `{invalid ${pii} token=${token} ${leakedHash}`, oldContainer: 'old-container', oldImage: 'old-image',
    startupLogs: `EACCES permission denied /srv/private/${leakedHash}\nENOENT /data/${pii}\nlisten EADDRINUSE 0.0.0.0:3020\n${pii} token=${token} ${leakedHash}`,
  })
  assert.notEqual(result.status, 0)
  const diagnostic = result.stderr.trim()
  assert.match(diagnostic, /candidate=1234567890ab image=sha256:1{64} health=unhealthy restarts=3 health_exit_codes=1,137/)
  assert.match(diagnostic, /logs=available startup_lines=4 startup_classes=permission-denied:1,missing-file:1,module-startup:0,port-binding:1,unclassified:1/)
  for (const secret of [token, leakedHash, pii, '99887766', 'EACCES', 'ENOENT', '/srv/private']) assert.doesNotMatch(diagnostic, new RegExp(secret))
  const tag = calls().findIndex((line) => line.includes('image tag old-image'))
  assert.ok(calls().findIndex((line) => line.includes('logs --tail 200')) < tag)
  assert.ok(tag < calls().findIndex((line, index) => index > tag && line.endsWith('up -d --no-build app')))
})
