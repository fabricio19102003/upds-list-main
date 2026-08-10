import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createServer, search } from '../server.mjs'

const root = mkdtempSync(join(tmpdir(), 'aulas-'))
const dataDir = join(root, 'data'), distDir = join(root, 'dist')
let server, base
before(async () => {
  mkdirSync(dataDir); mkdirSync(distDir)
  writeFileSync(join(distDir, 'index.html'), '<h1>Portal</h1>')
  writeFileSync(join(dataDir, 'students.txt'), `**1ER SEMESTRE | UPDS | TURMA M1 | AULA: 9**
| 1 | I-000000000-00 | Synthetic Student One |
| 2 | 00000000 | Synthetic Student Two |`)
  server = createServer({ dataDir, distDir }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true }) })

const post = (body, headers = {}) => fetch(`${base}/api/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
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
