import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createServer, search } from '../server.mjs'

const root = mkdtempSync(join(tmpdir(), 'aulas-'))
const dataDir = join(root, 'data'), distDir = join(root, 'dist'), tokenFile = join(root, 'token')
const token = 'a'.repeat(64), dataVersion = 'b'.repeat(64)
const assignment = { semester: 1, group: 'M1', shift: 'M', capacity: 40, classroom: { room: '9', building: 'Main', floor: '1', floorLabel: 'First floor' } }
const nullableAssignment = { semester: 2, group: 'N2', shift: 'N', capacity: null, classroom: { room: null, building: null, floor: null, floorLabel: null } }
const validResults = [
  { name: 'Synthetic Learner', documentHint: '••••A1B2', assignments: [assignment, nullableAssignment] },
  { name: null, documentHint: '••••0001', assignments: [nullableAssignment] },
]
let server, upstream, base, upstreamBase, upstreamBehavior = 'valid'
const upstreamRequests = []
const redirectTargetRequests = []
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) }
before(async () => {
  mkdirSync(dataDir); mkdirSync(distDir)
  writeFileSync(join(distDir, 'index.html'), '<h1>Portal</h1>')
  writeFileSync(tokenFile, token)
  writeFileSync(join(dataDir, 'students.txt'), `**1ER SEMESTRE | UPDS | TURMA M1 | AULA: 9**
| 1 | I-000000000-00 | Synthetic Student One |
| 2 | 00000000 | Synthetic Student Two |`)
  upstream = createHttpServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    if (request.url === '/redirect-target') {
      redirectTargetRequests.push({ hasAuthorization: Boolean(request.headers.authorization), text })
      if (upstreamBehavior.startsWith('redirect-metadata')) return json(response, 200, { apiVersion: 'v1', activePeriod: { code: '2026-2', displayName: '2/2026' }, dataVersion, scheduleAvailable: false })
      return json(response, 200, { activePeriod: '2026-2', dataVersion, results: structuredClone(validResults) })
    }
    upstreamRequests.push({
      method: request.method, url: request.url, authorized: request.headers.authorization === `Bearer ${token}`,
      accept: request.headers.accept, cache: request.headers['cache-control'], contentType: request.headers['content-type'], text,
    })
    if (request.headers.authorization !== `Bearer ${token}`) return json(response, 401, { error: { code: 'private_auth', detail: 'PRIVATE_DETAIL' } })
    const redirect = /^redirect-(?:metadata|search)-(301|302|303|307|308)$/.exec(upstreamBehavior)
    if (redirect) { response.writeHead(Number(redirect[1]), { Location: '/redirect-target' }); return response.end() }
    if (request.url?.endsWith('/metadata')) {
      const metadata = { apiVersion: 'v1', activePeriod: { code: '2026-2', displayName: '2/2026' }, dataVersion, scheduleAvailable: false }
      if (upstreamBehavior === 'metadata-period') metadata.activePeriod.code = '2026-3'
      if (upstreamBehavior === 'metadata-version') metadata.dataVersion = 'invalid'
      if (upstreamBehavior === 'metadata-api') metadata.apiVersion = 'v2'
      if (upstreamBehavior === 'metadata-schedule') metadata.scheduleAvailable = true
      if (upstreamBehavior === 'metadata-extra') metadata.private = 'PRIVATE_DETAIL'
      return json(response, 200, metadata)
    }
    if (upstreamBehavior === 'error') return json(response, 418, { code: 'private_code', rawDocument: 'SYNTHETIC-RAW-DOCUMENT', detail: 'PRIVATE_DETAIL' })
    if (upstreamBehavior === 'malformed') { response.writeHead(200, { 'Content-Type': 'application/json' }); return response.end('{') }
    if (upstreamBehavior === 'timeout') return setTimeout(() => json(response, 200, { activePeriod: '2026-2', dataVersion, results: [] }), 300)
    const payload = { activePeriod: '2026-2', dataVersion, results: structuredClone(validResults) }
    if (upstreamBehavior === 'search-period') payload.activePeriod = '2026-3'
    if (upstreamBehavior === 'search-version') payload.dataVersion = 'invalid'
    if (upstreamBehavior === 'search-schema') payload.results[0].assignments[1].capacity = '40'
    if (upstreamBehavior === 'search-extra') payload.results[0].private = 'PRIVATE_DETAIL'
    if (upstreamBehavior === 'search-many') payload.results = Array(11).fill(validResults[0])
    return json(response, 200, payload)
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => upstream.once('listening', resolve))
  upstreamBase = `http://127.0.0.1:${upstream.address().port}/api/integrations/student-classrooms/v1`
  server = createServer({ dataDir, distDir, studentLookup: { baseUrl: upstreamBase, tokenFile, period: '2026-2', timeoutMs: 100 } }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => upstream.close(resolve))
  rmSync(root, { recursive: true })
})

const post = (body, headers = {}) => fetch(`${base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const lookupPost = (body, headers = {}, suffix = '') => fetch(`${base}/api/student-search${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const expectPortalError = async (response, status) => {
  const text = await response.text(), value = JSON.parse(text)
  assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Object.keys(value), ['error'])
  assert.deepEqual(Object.keys(value.error).sort(), ['code', 'message'])
  assert.equal(typeof value.error.code, 'string'); assert.equal(typeof value.error.message, 'string')
  return text
}
const withPortal = async (studentLookup, callback) => {
  const instance = createServer({ dataDir, distDir, studentLookup }).listen(0, '127.0.0.1')
  await new Promise((resolve) => instance.once('listening', resolve))
  try { await callback(`http://127.0.0.1:${instance.address().port}`) } finally { await new Promise((resolve) => instance.close(resolve)) }
}
test('searches by exact document without returning it', async () => {
  const response = await post({ query: 'I-000000000-00', turno: 'ALL' })
  const text = await response.text()
  assert.equal(response.status, 200); assert.match(text, /Synthetic/); assert.doesNotMatch(text, /000000000/)
})
test('rejects unknown request properties', async () => {
  assert.equal((await post({ query: 'Synthetic One', turno: 'M', extra: true })).status, 400)
})
test('rejects URL query parameters', async () => {
  const response = await fetch(`${base}/api/search?extra=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Synthetic One', turno: 'M' }) })
  assert.equal(response.status, 400)
})
test('searches by name and rejects unsafe requests', async () => {
  assert.equal((await post({ query: 'Synthetic One', turno: 'M' })).status, 200)
  assert.equal((await post({ query: 'Ana', turno: 'ALL' })).status, 400)
  assert.equal((await fetch(`${base}/api/search`)).status, 405)
  assert.equal((await post({ query: 'Synthetic One', turno: 'M' }, { Origin: 'https://evil.example' })).status, 403)
  assert.equal((await fetch(`${base}/api/export`)).status, 404)
  assert.equal((await fetch(`${base}/api/search`, { method: 'POST', body: '{}' })).status, 415)
  assert.throws(() => search(Array(11).fill({ nameKey: 'common student', turno: 'M' }), { query: 'common student', turno: 'ALL' }), { status: 422 })
})

test('returns validated safe metadata without exposing private configuration', async () => {
  const response = await fetch(`${base}/api/student-search/metadata`), value = await response.json()
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(value, { activePeriod: { code: '2026-2', displayName: '2/2026' }, dataVersion, scheduleAvailable: false })
  const request = upstreamRequests.at(-1)
  assert.deepEqual({ method: request.method, authorized: request.authorized, accept: request.accept, cache: request.cache }, { method: 'GET', authorized: true, accept: 'application/json', cache: 'no-store' })
})

test('proxies exact name and document searches and preserves every nullable assignment', async () => {
  for (const body of [{ mode: 'name', query: '  Synthetic   Learner ' }, { mode: 'document', query: 'ZX-0001' }]) {
    const response = await lookupPost(body, body.mode === 'document' ? { Origin: 'https://aulas.upds-cobija.cloud' } : {}), text = await response.text(), value = JSON.parse(text)
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(Object.keys(value).sort(), ['activePeriod', 'dataVersion', 'results', 'scheduleAvailable'])
    assert.equal(value.results[0].assignments.length, 2); assert.deepEqual(value.results[0].assignments[1], nullableAssignment)
    assert.equal(value.results[1].name, null); assert.equal(value.results[1].assignments[0].classroom.room, null)
    assert.doesNotMatch(text, /ZX-0001|a{64}/)
    const request = upstreamRequests.at(-1), sent = JSON.parse(request.text)
    assert.deepEqual(Object.keys(sent).sort(), ['mode', 'query']); assert.equal(sent.mode, body.mode); assert.equal(sent.query, body.query.trim().replace(/\s+/g, ' '))
    assert.equal(request.method, 'POST'); assert.equal(request.contentType, 'application/json'); assert.equal(request.authorized, true)
  }
})

test('enforces exact public methods, queries, origins, content type, body size, and input keys', async () => {
  await expectPortalError(await fetch(`${base}/api/student-search`), 405)
  await expectPortalError(await fetch(`${base}/api/student-search/metadata`, { method: 'POST' }), 405)
  await expectPortalError(await lookupPost({ mode: 'name', query: 'Synthetic' }, {}, '?extra=true'), 400)
  await expectPortalError(await fetch(`${base}/api/student-search/metadata?extra=true`), 400)
  await expectPortalError(await lookupPost({ mode: 'name', query: 'Synthetic' }, { Origin: 'https://evil.example' }), 403)
  await expectPortalError(await fetch(`${base}/api/student-search/metadata`, { headers: { Origin: 'https://evil.example' } }), 403)
  await expectPortalError(await fetch(`${base}/api/student-search`, { method: 'POST', body: '{}' }), 415)
  await expectPortalError(await fetch(`${base}/api/student-search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), 400)
  await expectPortalError(await lookupPost({ mode: 'name', query: 'x'.repeat(1100) }), 413)
  for (const body of [
    { mode: 'name', query: 'ab' }, { mode: 'document', query: '---' }, { mode: 'other', query: 'Synthetic' },
    { mode: 'name', query: 'Synthetic', extra: true }, { query: 'Synthetic' }, { mode: 'name', query: 'x'.repeat(101) },
  ]) await expectPortalError(await lookupPost(body), 400)
})

test('rejects every metadata and search contract drift with one sanitized unavailable error', async () => {
  try {
    for (const behavior of ['metadata-period', 'metadata-version', 'metadata-api', 'metadata-schedule', 'metadata-extra']) {
      upstreamBehavior = behavior
      const text = await expectPortalError(await fetch(`${base}/api/student-search/metadata`), 503)
      assert.doesNotMatch(text, /PRIVATE_DETAIL|private_code|2026-3/)
    }
    for (const behavior of ['search-period', 'search-version', 'search-schema', 'search-extra', 'search-many', 'malformed', 'error', 'timeout']) {
      upstreamBehavior = behavior
      const text = await expectPortalError(await lookupPost({ mode: 'name', query: 'Synthetic' }), 503)
      assert.doesNotMatch(text, /PRIVATE_DETAIL|private_code|SYNTHETIC-RAW-DOCUMENT|418|2026-3/)
    }
  } finally { upstreamBehavior = 'valid' }
})

test('rejects every upstream redirect without sending authorization or bodies to its target', async () => {
  const genericError = JSON.stringify({ error: { code: 'unavailable', message: 'Search is temporarily unavailable. Please try again.' } })
  try {
    for (const status of [301, 302, 303, 307, 308]) {
      upstreamBehavior = `redirect-metadata-${status}`
      assert.equal(await expectPortalError(await fetch(`${base}/api/student-search/metadata`), 503), genericError)
      upstreamBehavior = `redirect-search-${status}`
      assert.equal(await expectPortalError(await lookupPost({ mode: 'name', query: 'Redirect Probe' }), 503), genericError)
    }
    assert.deepEqual(redirectTargetRequests, [])
  } finally { upstreamBehavior = 'valid' }
})

test('keeps missing and invalid new-route configuration isolated from legacy startup', async () => {
  const requestCount = upstreamRequests.length
  for (const contents of ['f'.repeat(63), 'g'.repeat(64)]) {
    writeFileSync(tokenFile, contents)
    await expectPortalError(await fetch(`${base}/api/student-search/metadata`), 503)
  }
  rmSync(tokenFile)
  await expectPortalError(await fetch(`${base}/api/student-search/metadata`), 503)
  assert.equal(upstreamRequests.length, requestCount)
  writeFileSync(tokenFile, token)
  assert.equal((await post({ query: 'Synthetic One', turno: 'M' })).status, 200)
  await withPortal({ baseUrl: '', tokenFile: '', period: '' }, async (localBase) => {
    await expectPortalError(await fetch(`${localBase}/api/student-search/metadata`), 503)
    const response = await fetch(`${localBase}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'Synthetic One', turno: 'M' }) })
    assert.equal(response.status, 200)
  })
  await withPortal({ baseUrl: upstreamBase, tokenFile, period: '2026-1' }, async (localBase) => {
    await expectPortalError(await fetch(`${localBase}/api/student-search/metadata`), 503)
  })
})
