import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_BODY = 1024
const PUBLIC_ORIGIN = 'https://aulas.upds-cobija.cloud'
const normalize = (value) => value.toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '')

function schedule(semester, shift) {
  const hours = { M: ['06:30', semester === '6' ? '14:00' : semester === '7' ? '13:40' : semester === '5' ? '13:00' : '12:00'], T: ['12:00', '17:30'], N: [semester === '6' ? '15:30' : semester === '7' ? '16:00' : semester === '5' ? '17:00' : '17:30', '23:00'] }
  const names = { M: 'Mañana', T: 'Tarde', N: 'Noche' }
  return hours[shift] ? `${names[shift]} (${hours[shift].join(' - ')})` : names[shift] || ''
}

export function loadStudents(dataDir) {
  const students = []
  for (const file of readdirSync(dataDir).filter((name) => name.endsWith('.txt'))) {
    let semester = '', group = '', room = '', shift = ''
    for (const line of readFileSync(resolve(dataDir, file), 'utf8').split('\n')) {
      const header = line.match(/\*\*(\d+)[A-Z]+\s*SEMESTRE\s*\|\s*UPDS\s*\|\s*TURMA\s*([MTNA-Z\d\s]+?)(?:\s*\|\s*AULA:\s*(.+?))?\*\*/i)
      if (header) {
        ;[, semester, group] = header
        room = header[3]?.trim() || 'Por asignar'; group = group.trim(); shift = group[0].toUpperCase()
        continue
      }
      const row = line.match(/\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/)
      if (row && semester && row[1].trim() !== 'IDENTIDAD') students.push({
        code: normalize(row[1]), nameKey: normalize(row[2]), nombre: row[2].trim(), grupo: group,
        turno: shift, horario: schedule(semester, shift), sala: room, semestre: `${semester}º Semestre`,
      })
    }
  }
  return students
}

export function search(students, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
    || !Object.hasOwn(input, 'query') || !Object.hasOwn(input, 'turno')
    || typeof input.query !== 'string' || !['ALL', 'M', 'T', 'N'].includes(input.turno)) throw Object.assign(new Error('invalid_request'), { status: 400 })
  const query = input.query.trim()
  if (query.length < 6 || query.length > 80 || /[\u0000-\u001f\u007f]/.test(query)) throw Object.assign(new Error('invalid_query'), { status: 400 })
  const key = normalize(query).trim(), terms = key.split(/\s+/), isDocument = terms.length === 1
  if (isDocument && !/^[a-z0-9-]{6,24}$/i.test(query)) throw Object.assign(new Error('invalid_query'), { status: 400 })
  if (!key || (!isDocument && (terms.length < 2 || terms.some((term) => term.length < 2)))) throw Object.assign(new Error('invalid_query'), { status: 400 })
  const matches = students.filter((student) => (input.turno === 'ALL' || student.turno === input.turno)
    && (isDocument ? student.code === key : terms.every((term) => student.nameKey.includes(term))))
  if (matches.length > 10) throw Object.assign(new Error('refine_query'), { status: 422 })
  return matches.map(({ nombre, grupo, turno, horario, sala, semestre }) => ({ nombre, grupo, turno, horario, sala, semestre }))
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

const types = { '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.svg': 'image/svg+xml' }
export function createServer({ dataDir = process.env.DATA_DIR || '/app/data', distDir = process.env.DIST_DIR || resolve('dist') } = {}) {
  const students = loadStudents(dataDir), root = resolve(distDir)
  return createHttpServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)) }
    const url = new URL(request.url, 'http://localhost'), { pathname } = url
    if (pathname === '/health') return send(200, { status: 'ok' })
    if (pathname === '/api/search') {
      if (request.method !== 'POST') return send(405, { error: 'method_not_allowed' })
      if (url.searchParams.size) return send(400, { error: 'invalid_request' })
      if (request.headers.origin && request.headers.origin !== PUBLIC_ORIGIN) return send(403, { error: 'forbidden_origin' })
      try { return send(200, { results: search(students, await readJson(request)) }) } catch (error) { return send(error.status || 500, { error: error.status ? error.message : 'internal_error' }) }
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
