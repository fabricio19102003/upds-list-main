import { createReadStream, readFileSync, statSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_BODY = 1024
const PUBLIC_ORIGIN = 'https://aulas.upds-cobija.cloud'
const LOOKUP_PATH = '/api/integrations/student-classrooms/v1'
const PRIVATE_BASE_URL = `http://cupos-turmas-student-classrooms-v1:3000${LOOKUP_PATH}`
const PINNED_PERIOD = '2026-2'
const LOOKUP_TIMEOUT_MS = 5000
const HEX_64 = /^[a-f0-9]{64}$/i
const portalErrors = {
  400: { error: { code: 'invalid_request', message: 'Invalid request.' } },
  403: { error: { code: 'forbidden', message: 'Request not allowed.' } },
  405: { error: { code: 'method_not_allowed', message: 'Method not allowed.' } },
  413: { error: { code: 'request_too_large', message: 'Invalid request.' } },
  415: { error: { code: 'unsupported_media_type', message: 'Invalid request.' } },
  503: { error: { code: 'unavailable', message: 'Search is temporarily unavailable. Please try again.' } },
}
async function readJson(request) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw Object.assign(new Error('unsupported_media_type'), { status: 415 })
  if (Number(request.headers['content-length'] || 0) > MAX_BODY) throw Object.assign(new Error('payload_too_large'), { status: 413 })
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body) > MAX_BODY) throw Object.assign(new Error('payload_too_large'), { status: 413 })
  }
  try { return JSON.parse(body) } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }) }
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key))
const nullableString = (value) => value === null || (typeof value === 'string' && Boolean(value.trim()))
const unavailable = () => { throw new Error('lookup_unavailable') }

function lookupInput(value) {
  if (!hasExactKeys(value, ['mode', 'query']) || !['name', 'document'].includes(value.mode)
    || typeof value.query !== 'string') return null
  const query = value.query.trim().replace(/\s+/g, ' ')
  if (!query || query.length > 100) return null
  if (value.mode === 'name') {
    if (query.normalize('NFD').replace(/\p{M}/gu, '').trim().length < 3) return null
  } else if (!/[\p{L}\p{N}]/u.test(query)) return null
  return { mode: value.mode, query }
}

function lookupConfig(overrides) {
  const injectedBaseUrl = overrides.baseUrl
  const baseUrl = injectedBaseUrl ?? process.env.CUPOS_STUDENT_CLASSROOM_BASE_URL
  const tokenFile = overrides.tokenFile ?? process.env.CUPOS_STUDENT_CLASSROOM_TOKEN_FILE
  const period = overrides.period ?? process.env.STUDENT_LOOKUP_PERIOD
  const timeoutMs = overrides.timeoutMs ?? LOOKUP_TIMEOUT_MS
  let url
  try { url = new URL(baseUrl) } catch { unavailable() }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
    || url.pathname !== LOOKUP_PATH || typeof tokenFile !== 'string' || !tokenFile.startsWith('/')
    || (injectedBaseUrl === undefined && baseUrl !== PRIVATE_BASE_URL)
    || period !== PINNED_PERIOD || !Number.isInteger(timeoutMs) || timeoutMs < 1) unavailable()
  let token
  try { token = readFileSync(tokenFile, 'utf8').trim() } catch { unavailable() }
  if (!HEX_64.test(token)) unavailable()
  return { baseUrl: url.href, period, timeoutMs, token }
}

async function privateRequest(overrides, endpoint, payload) {
  const config = lookupConfig(overrides)
  const response = await fetch(`${config.baseUrl}/${endpoint}`, {
    method: payload ? 'POST' : 'GET',
    headers: {
      Accept: 'application/json', Authorization: `Bearer ${config.token}`, 'Cache-Control': 'no-store',
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs),
  })
  if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel()
    unavailable()
  }
  try { return { config, value: await response.json() } } catch { unavailable() }
}

function validatedMetadata(value, period) {
  if (!hasExactKeys(value, ['apiVersion', 'activePeriod', 'dataVersion', 'scheduleAvailable'])
    || value.apiVersion !== 'v1' || value.scheduleAvailable !== false || !HEX_64.test(value.dataVersion)
    || !hasExactKeys(value.activePeriod, ['code', 'displayName']) || value.activePeriod.code !== period
    || typeof value.activePeriod.displayName !== 'string' || !value.activePeriod.displayName.trim()) unavailable()
  return { apiVersion: 'v1', activePeriod: { code: value.activePeriod.code, displayName: value.activePeriod.displayName }, dataVersion: value.dataVersion, scheduleAvailable: false }
}

function validatedSearch(value, period) {
  if (!hasExactKeys(value, ['activePeriod', 'dataVersion', 'results']) || value.activePeriod !== period
    || !HEX_64.test(value.dataVersion) || !Array.isArray(value.results) || value.results.length > 10) unavailable()
  const results = value.results.map((student) => {
    if (!hasExactKeys(student, ['name', 'documentHint', 'assignments']) || !nullableString(student.name)
      || typeof student.documentHint !== 'string' || !/^••••[•\p{L}\p{N}]{4}$/u.test(student.documentHint)
      || !Array.isArray(student.assignments)) unavailable()
    const assignments = student.assignments.map((assignment) => {
      if (!hasExactKeys(assignment, ['semester', 'group', 'shift', 'capacity', 'classroom'])
        || !Number.isInteger(assignment.semester) || assignment.semester < 1
        || typeof assignment.group !== 'string' || !assignment.group.trim()
        || typeof assignment.shift !== 'string' || !assignment.shift.trim()
        || !(assignment.capacity === null || (Number.isInteger(assignment.capacity) && assignment.capacity >= 0))
        || !hasExactKeys(assignment.classroom, ['room', 'building', 'floor', 'floorLabel'])
        || !['room', 'building', 'floor', 'floorLabel'].every((key) => nullableString(assignment.classroom[key]))) unavailable()
      return {
        semester: assignment.semester, group: assignment.group, shift: assignment.shift, capacity: assignment.capacity,
        classroom: { room: assignment.classroom.room, building: assignment.classroom.building, floor: assignment.classroom.floor, floorLabel: assignment.classroom.floorLabel },
      }
    })
    return { name: student.name, documentHint: student.documentHint, assignments }
  })
  return { activePeriod: value.activePeriod, dataVersion: value.dataVersion, scheduleAvailable: false, results }
}

const types = { '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.svg': 'image/svg+xml' }
export function createServer({ distDir = process.env.DIST_DIR || resolve('dist'), studentLookup = {} } = {}) {
  const root = resolve(distDir)
  return createHttpServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)) }
    const url = new URL(request.url, 'http://localhost'), { pathname } = url
    if (pathname === '/health') return send(200, { status: 'ok' })
    if (pathname === '/api/student-search/metadata' || pathname === '/api/student-search') {
      const metadata = pathname.endsWith('/metadata')
      if (request.method !== (metadata ? 'GET' : 'POST')) return send(405, portalErrors[405])
      if (url.searchParams.size) return send(400, portalErrors[400])
      if (request.headers.origin && request.headers.origin !== PUBLIC_ORIGIN) return send(403, portalErrors[403])
      if (metadata) {
        try {
          const { config, value } = await privateRequest(studentLookup, 'metadata')
          return send(200, validatedMetadata(value, config.period))
        } catch { return send(503, portalErrors[503]) }
      }
      let input
      try { input = lookupInput(await readJson(request)) } catch (error) { return send(error.status || 400, portalErrors[error.status] || portalErrors[400]) }
      if (!input) return send(400, portalErrors[400])
      try {
        const { config, value } = await privateRequest(studentLookup, 'search', input)
        return send(200, validatedSearch(value, config.period))
      } catch { return send(503, portalErrors[503]) }
    }
    if (pathname.startsWith('/api/')) return send(404, { error: 'not_found' })
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, { error: 'method_not_allowed' })
    let file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    try { if (!file.startsWith(`${root}/`) || !statSync(file).isFile()) file = resolve(root, 'index.html') } catch { file = resolve(root, 'index.html') }
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' })
    if (request.method === 'HEAD') return response.end()
    createReadStream(file).pipe(response)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createServer().listen(Number(process.env.PORT || 3000), '0.0.0.0')
