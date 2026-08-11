import { useEffect, useRef, useState } from 'react'
import './App.css'

const getTurnoColor = (turno) => {
  if (turno === 'M') return 'bg-yellow-100/90 text-yellow-800 shadow-sm ring-1 ring-yellow-300/60';
  if (turno === 'T') return 'bg-orange-100/90 text-orange-800 shadow-sm ring-1 ring-orange-300/60';
  if (turno === 'N') return 'bg-blue-100/90 text-blue-800 shadow-sm ring-1 ring-blue-300/60';
  return 'bg-slate-100/90 text-slate-800 shadow-sm ring-1 ring-slate-300/60';
};

const getGrupoColor = (grupo) => {
  const colors = [
    'bg-emerald-100/80 text-emerald-700 ring-emerald-200/50',
    'bg-purple-100/80 text-purple-700 ring-purple-200/50',
    'bg-pink-100/80 text-pink-700 ring-pink-200/50',
    'bg-rose-100/80 text-rose-700 ring-rose-200/50',
    'bg-cyan-100/80 text-cyan-700 ring-cyan-200/50',
    'bg-teal-100/80 text-teal-700 ring-teal-200/50',
    'bg-fuchsia-100/80 text-fuchsia-700 ring-fuchsia-200/50',
    'bg-violet-100/80 text-violet-700 ring-violet-200/50'
  ];
  let hash = 0;
  for (let i = 0; i < grupo.length; i++) {
    hash = grupo.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length] + ' shadow-sm ring-1';
};

const classroomLabel = (classroom) => {
  if (!classroom) return 'Aula, edificio y piso no informados'
  const floor = classroom.floorLabel || (classroom.floor ? `Piso ${classroom.floor}` : 'Piso no informado')
  return [classroom.room ? `Aula ${classroom.room}` : 'Aula no informada', classroom.building ? `Edificio ${classroom.building}` : 'Edificio no informado', floor].join(' · ')
}

const App = () => {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [searchMode, setSearchMode] = useState('name')
  const [searchState, setSearchState] = useState('idle')
  const [portal, setPortal] = useState({ metadata: null, students: [] })
  const [isLoading, setIsLoading] = useState(true)
  const [metadataUnavailable, setMetadataUnavailable] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const requestId = useRef(0)
  const searchController = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    const loadMetadata = async () => {
      try {
        const response = await fetch('/api/student-search/metadata', { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error('unavailable')
        const metadata = await response.json()
        if (!metadata?.activePeriod?.code || typeof metadata.activePeriod.displayName !== 'string' || typeof metadata.dataVersion !== 'string' || metadata.scheduleAvailable !== false) throw new Error('invalid_metadata')
        setPortal((current) => ({ ...current, metadata }))
      } catch (error) {
        if (error?.name !== 'AbortError') setMetadataUnavailable(true)
      } finally {
        if (!controller.signal.aborted) setIsLoading(false)
      }
    }
    loadMetadata()
    return () => { controller.abort(); searchController.current?.abort() }
  }, [])

  const cancelSearch = () => {
    requestId.current += 1
    searchController.current?.abort()
    searchController.current = null
    setIsSearching(false)
  }

  const runSearch = async () => {
    const query = searchQuery.trim().replace(/\s+/g, ' ')
    cancelSearch()
    setSearchTerm(query)
    setPortal((current) => ({ ...current, students: [] }))
    const valid = query.length <= 100 && (searchMode === 'name'
      ? query.normalize('NFD').replace(/\p{M}/gu, '').length >= 3
      : /[\p{L}\p{N}]/u.test(query))
    if (!valid) { setSearchState('validation'); return }
    const id = requestId.current
    const controller = new AbortController()
    searchController.current = controller
    setSearchState('searching')
    setIsSearching(true)
    try {
      const response = await fetch('/api/student-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: searchMode, query }),
        cache: 'no-store',
        signal: controller.signal,
      })
      if (id !== requestId.current) return
      if (!response.ok) {
        setSearchState([400, 413, 415].includes(response.status) ? 'validation' : 'unavailable')
        return
      }
      const payload = await response.json()
      if (id !== requestId.current || typeof payload?.activePeriod !== 'string' || !Array.isArray(payload.results) || typeof payload.dataVersion !== 'string' || payload.scheduleAvailable !== false) return setSearchState('unavailable')
      setPortal((current) => ({
        metadata: {
          activePeriod: { code: payload.activePeriod, displayName: current.metadata?.activePeriod?.code === payload.activePeriod ? current.metadata.activePeriod.displayName : payload.activePeriod },
          dataVersion: payload.dataVersion,
          scheduleAvailable: false,
        },
        students: payload.results,
      }))
      setMetadataUnavailable(false)
      setSearchState(payload.results.length ? 'success' : 'empty')
    } catch (error) {
      if (error?.name !== 'AbortError' && id === requestId.current) setSearchState('unavailable')
    } finally {
      if (id === requestId.current) { setIsSearching(false); searchController.current = null }
    }
  }

  const handleClear = () => {
    cancelSearch()
    setSearchQuery('')
    setSearchTerm('')
    setSearchState('idle')
    setPortal((current) => ({ ...current, students: [] }))
  }

  const handleModeChange = (mode) => {
    cancelSearch()
    setSearchMode(mode)
    setSearchTerm('')
    setSearchState('idle')
    setPortal((current) => ({ ...current, students: [] }))
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') runSearch()
  }

  const rows = portal.students.flatMap((student) => student.assignments.length
    ? student.assignments.map((assignment) => ({ student, assignment }))
    : [{ student, assignment: null }])

  return (
    <div className="min-h-screen w-full min-w-0 overflow-x-hidden flex flex-col bg-gradient-to-br from-slate-50 via-white to-sky-50 font-sans selection:bg-sky-200 selection:text-blue-900">
      {/* Premium Glassmorphism Header (Dark Blue) */}
      <header className="fixed inset-x-0 top-0 z-50 bg-blue-900/95 backdrop-blur-xl border-b border-blue-800 shadow-md">
        <div className="max-w-7xl min-w-0 mx-auto px-3 min-[360px]:px-4 sm:px-6 h-16 sm:h-20 flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2 min-[360px]:gap-3 sm:gap-4 group cursor-pointer">
            <div className="flex shrink-0 items-center justify-center bg-white rounded-xl px-3 py-1.5 min-[360px]:px-4 sm:px-5 sm:py-2 shadow-lg shadow-black/10 ring-1 ring-white/30 transform transition-transform group-hover:scale-105 group-hover:rotate-1 duration-300">
              <span className="text-2xl sm:text-3xl font-black italic tracking-tighter text-blue-900 drop-shadow-sm">
                UPDS
              </span>
            </div>
            <span className="min-w-0 text-lg min-[360px]:text-xl sm:text-3xl font-extrabold tracking-tight text-white drop-shadow-sm transition-colors group-hover:text-sky-200">
              Cobija
            </span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className={`w-full min-w-0 flex-grow flex flex-col items-center px-3 min-[360px]:px-4 sm:px-6 relative overflow-hidden transition-all duration-700 ease-in-out ${searchTerm ? 'pt-24 sm:pt-32' : 'justify-center pt-24 sm:pt-32'}`}>
        
        {/* Dynamic Background Glowing Orbs */}
        <div className="absolute top-0 right-0 -translate-y-1/3 translate-x-1/3 w-[300px] sm:w-[600px] h-[300px] sm:h-[600px] bg-sky-200/40 rounded-full blur-[60px] sm:blur-[100px] pointer-events-none animate-pulse" style={{ animationDuration: '4s' }} />
        <div className="absolute bottom-0 left-0 translate-y-1/3 -translate-x-1/3 w-[300px] sm:w-[600px] h-[300px] sm:h-[600px] bg-blue-200/30 rounded-full blur-[60px] sm:blur-[100px] pointer-events-none animate-pulse" style={{ animationDuration: '6s' }} />

        {isLoading ? (
          <div className="w-full flex-grow flex flex-col items-center justify-center relative z-10 transition-opacity duration-1000">
            <div className="relative flex items-center justify-center w-24 h-24 mb-6">
              {/* Outer dashed spinning ring */}
              <div className="absolute inset-0 rounded-full border-t-4 border-b-4 border-blue-600 animate-spin"></div>
              {/* Inner reversed spinning ring */}
              <div className="absolute inset-0 rounded-full border-r-4 border-l-4 border-sky-400 animate-[spin_1.5s_linear_infinite_reverse] opacity-70"></div>
              {/* Static center pulse */}
              <div className="w-12 h-12 bg-blue-900 rounded-full flex items-center justify-center shadow-lg shadow-blue-900/40 animate-pulse">
                <span className="text-white font-black italic tracking-tighter text-xs">UPDS</span>
              </div>
            </div>
            <h2 className="text-center text-2xl sm:text-3xl font-extrabold text-blue-900 mb-2 drop-shadow-sm">Conectando con el portal</h2>
            <p className="text-slate-500 font-medium text-lg max-w-sm text-center">Confirmando el periodo académico disponible...</p>
          </div>
        ) : (
          <div className="w-full min-w-0 max-w-7xl mx-auto relative z-10 animate-fade-in-up">
            <div className={`text-center space-y-5 sm:space-y-8 transition-all duration-700 ease-out transform ${searchTerm ? 'mb-8 sm:mb-12 scale-95 opacity-90' : 'mb-12 sm:mb-16 scale-100 opacity-100'}`}>
              <div className="inline-flex max-w-full items-center gap-2 px-3 min-[360px]:px-4 py-2 rounded-full bg-blue-50/80 border border-blue-100/50 shadow-sm text-blue-800 text-sm font-semibold tracking-wide backdrop-blur-sm">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </span>
                Portal de Búsqueda Estudiantil
              </div>

              {portal.metadata ? (
                <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-center gap-2 text-sm font-semibold" role="status">
                  <span className="max-w-full break-words rounded-full bg-emerald-50 px-3 py-1.5 text-emerald-800 ring-1 ring-emerald-200">Periodo {portal.metadata.activePeriod.displayName}{portal.metadata.activePeriod.displayName !== portal.metadata.activePeriod.code && ` (${portal.metadata.activePeriod.code})`}</span>
                  <span className="max-w-full break-all rounded-full bg-slate-100 px-3 py-1.5 text-slate-700" title={`Versión de datos ${portal.metadata.dataVersion}`}>Datos {portal.metadata.dataVersion.slice(0, 8)}</span>
                  <span className="w-full break-words text-amber-800">Los horarios aún no están disponibles. Consulta aquí tu grupo y aula asignados.</span>
                </div>
              ) : metadataUnavailable ? (
                <p className="mx-auto max-w-xl rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-200" role="status">No pudimos confirmar el periodo en este momento. Aún puedes intentar una búsqueda.</p>
              ) : null}
              
              <h1 className="text-4xl min-[360px]:text-5xl sm:text-6xl md:text-8xl font-black tracking-tighter text-slate-900 drop-shadow-sm leading-[1.1]">
                Encuentra tu <br className="sm:hidden" /><span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-900 via-blue-700 to-sky-400">Sala</span>
              </h1>
              
              {!searchTerm && (
                <div className="space-y-6 animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
                  <p className="text-lg sm:text-2xl text-slate-600 max-w-3xl mx-auto font-medium tracking-tight leading-relaxed px-4">
                    Ingresa tu nombre completo o documento de identidad para consultar tu <strong className="text-blue-900">grupo y aula</strong> asignados.
                  </p>
                  
                  {/* Information Card for Brazilian Students */}
                  {searchMode === 'document' && <div className="block w-full bg-gradient-to-br from-amber-50/90 to-yellow-50/50 backdrop-blur-md border border-amber-200/60 rounded-2xl p-4 sm:p-5 shadow-sm max-w-xl mx-auto text-left relative overflow-hidden group">
                    <div className="absolute top-0 left-0 w-1.5 h-full bg-amber-400"></div>
                    <div className="flex items-start gap-3 sm:gap-4">
                      <div className="mt-1 flex-shrink-0 bg-white p-1.5 rounded-full shadow-sm text-amber-500 ring-1 ring-amber-100">
                        <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm sm:text-base font-bold text-amber-900 mb-1.5 tracking-tight">
                          Aviso para estudantes brasileiros 🇧🇷
                        </h3>
                        <p className="text-xs sm:text-sm text-amber-800/90 font-medium leading-relaxed">
                          Se desejar buscar pelo seu documento de identidade, você deve usar o seguinte formato: a letra <strong className="font-bold text-amber-900 bg-amber-200/50 px-1.5 py-0.5 rounded-md">I-</strong> antes do número. <br className="hidden sm:block" />
                          <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 mt-2.5 break-all font-mono text-[11px] sm:text-xs bg-white/80 px-2.5 py-1.5 rounded-md border border-amber-200/80 text-amber-900 shadow-sm">
                            <span className="text-amber-500 font-sans font-semibold">Exemplo:</span> I-XXXXXXXXX-XX
                          </span>
                        </p>
                      </div>
                    </div>
                  </div>}
                </div>
              )}
            </div>

            <fieldset className="mx-auto mb-4 flex w-full max-w-xs rounded-2xl bg-white/90 p-1.5 shadow-sm ring-1 ring-slate-200">
              <legend className="sr-only">Tipo de búsqueda</legend>
              {[['name', 'Nombre'], ['document', 'Documento']].map(([mode, label]) => (
                <button key={mode} type="button" onClick={() => handleModeChange(mode)} aria-pressed={searchMode === mode}
                  className={`min-h-11 min-w-0 flex-1 rounded-xl px-3 py-2 text-sm font-bold transition ${searchMode === mode ? 'bg-blue-900 text-white shadow-md' : 'text-slate-600 hover:bg-blue-50 hover:text-blue-900'}`}>
                  {label}
                </button>
              ))}
            </fieldset>

            {/* Premium Search Bar */}
            <div className="group relative bg-white/80 backdrop-blur-2xl rounded-2xl sm:rounded-3xl p-2 sm:p-3 shadow-[0_8px_30px_rgb(0,0,0,0.08)] border border-white/80 hover:shadow-[0_8px_30px_rgb(0,119,230,0.12)] focus-within:shadow-[0_8px_30px_rgb(0,119,230,0.15)] focus-within:ring-4 focus-within:ring-sky-500/20 transition-all duration-500 max-w-4xl mx-auto w-full">
              <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
                <div className="min-w-0 flex-grow relative flex items-center">
                  <div className="absolute left-4 sm:left-6 text-sky-500 transition-transform duration-300 group-focus-within:scale-110 group-focus-within:text-blue-600">
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={searchMode === 'name' ? 'Nombre completo...' : 'Documento de identidad...'}
                    aria-label={searchMode === 'name' ? 'Buscar por nombre' : 'Buscar por documento'}
                    className="w-full min-w-0 h-12 sm:h-16 pl-12 sm:pl-16 pr-12 sm:pr-14 bg-transparent border-0 focus:ring-0 text-slate-800 placeholder:text-slate-400 text-base sm:text-xl font-medium rounded-xl sm:rounded-2xl transition-all"
                  />
                  {searchQuery && (
                  <button
                    onClick={handleClear}
                    className="absolute right-1 flex size-11 items-center justify-center rounded-full text-slate-400 hover:text-slate-600 transition-colors hover:bg-slate-100"
                    aria-label="Limpiar búsqueda"
                  >
                    <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              <button
                onClick={runSearch}
                disabled={isSearching}
                className={`h-12 sm:h-16 w-full sm:w-40 bg-gradient-to-r from-blue-900 to-blue-800 hover:from-blue-800 hover:to-blue-700 text-white font-bold text-base sm:text-lg rounded-xl sm:rounded-2xl shadow-lg shadow-blue-900/30 hover:shadow-blue-900/40 active:scale-[0.97] transition-all flex items-center justify-center gap-2 ${isSearching ? 'opacity-75 cursor-not-allowed' : ''}`}
              >
                {isSearching ? 'Buscando...' : 'Buscar'}
              </button>
            </div>
          </div>

            <div className="mt-8 mb-16 w-full">
              {isSearching ? (
                <div className="overflow-hidden bg-white/80 backdrop-blur-xl rounded-2xl sm:rounded-3xl border border-white/50 shadow-[0_8px_30px_rgb(0,0,0,0.08)]">
                  {/* Skeleton Mobile */}
                   <div className="lg:hidden divide-y divide-slate-100">
                    {[1, 2, 3].map((_, i) => (
                      <div key={i} className="p-4 sm:p-5">
                        <div className="flex flex-col gap-3">
                          <div className="h-5 w-3/4 rounded-md skeleton"></div>
                          <div className="flex gap-2">
                            <div className="h-6 w-16 rounded-md skeleton"></div>
                            <div className="h-5 w-24 rounded-md skeleton"></div>
                          </div>
                          <div className="flex justify-between mt-2 pt-2 border-t border-slate-100/60">
                            <div className="h-6 w-24 rounded-full skeleton"></div>
                            <div className="h-6 w-16 rounded-full skeleton"></div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Skeleton Desktop */}
                   <div className="hidden lg:block overflow-hidden">
                     <table className="w-full table-fixed text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50/50 border-b border-slate-100">
                          <th className="px-6 py-4 lg:px-8 lg:py-5"><div className="h-4 w-32 skeleton rounded"></div></th>
                          <th className="px-6 py-4 lg:px-8 lg:py-5"><div className="h-4 w-16 skeleton rounded"></div></th>
                          <th className="px-6 py-4 lg:px-8 lg:py-5"><div className="h-4 w-24 skeleton rounded"></div></th>
                          <th className="px-6 py-4 lg:px-8 lg:py-5"><div className="h-4 w-16 skeleton rounded"></div></th>
                          <th className="px-6 py-4 lg:px-8 lg:py-5"><div className="h-4 w-20 skeleton rounded ml-auto"></div></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {[1, 2, 3, 4].map((_, i) => (
                          <tr key={i}>
                            <td className="px-6 py-5 lg:px-8 lg:py-6"><div className="h-5 w-48 skeleton rounded"></div></td>
                            <td className="px-6 py-5 lg:px-8 lg:py-6"><div className="h-6 w-16 skeleton rounded-lg"></div></td>
                            <td className="px-6 py-5 lg:px-8 lg:py-6"><div className="h-6 w-32 skeleton rounded-full"></div></td>
                            <td className="px-6 py-5 lg:px-8 lg:py-6"><div className="h-6 w-20 skeleton rounded-full"></div></td>
                            <td className="px-6 py-5 lg:px-8 lg:py-6"><div className="h-5 w-24 skeleton rounded ml-auto"></div></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : searchState === 'success' && rows.length > 0 ? (
                <div className="overflow-hidden bg-white/80 backdrop-blur-xl rounded-2xl sm:rounded-3xl border border-white/50 shadow-[0_8px_30px_rgb(0,0,0,0.08)]">
                  
                  {/* Mobile View (Cards) */}
                   <div className="lg:hidden divide-y divide-slate-100">
                    {rows.map(({ student, assignment }, idx) => (
                      <div key={idx} className="p-4 sm:p-5 hover:bg-sky-50/50 transition-colors animate-fade-in-up" style={{ animationDelay: `${idx * 0.05}s` }}>
                        <div className="flex flex-col gap-2">
                           <div className="min-w-0 break-words font-bold text-slate-800 text-lg leading-tight">
                            {student.name || 'Nombre no registrado'}
                             <span className="mt-1 block break-all font-mono text-xs font-medium text-slate-400">{student.documentHint}</span>
                          </div>
                          <div className="flex flex-wrap gap-2 items-center mt-1">
                             <span className={`max-w-full break-words px-2.5 py-1 ${getGrupoColor(assignment?.group || 'Sin grupo')} rounded-md text-xs font-bold uppercase tracking-wide`}>
                              Grupo {assignment?.group || 'no informado'}
                            </span>
                            <span className="text-slate-500 font-medium text-sm">
                               {assignment?.semester === null || assignment?.semester === undefined ? 'Semestre no informado' : `Semestre ${assignment.semester}`}
                            </span>
                          </div>
                           <div className="flex min-w-0 flex-col items-start mt-2 pt-2 border-t border-slate-100/60 gap-2">
                             <span className={`inline-flex max-w-full items-center break-words px-3 py-1 rounded-full text-xs font-bold ${getTurnoColor(assignment?.shift)}`}>
                              Turno {assignment?.shift || 'no informado'}
                            </span>
                             <span className="inline-flex max-w-full items-center break-words px-3 py-1 rounded-xl text-xs font-bold bg-sky-100/80 text-blue-800 ring-1 ring-sky-200/50 shadow-sm">
                               {classroomLabel(assignment?.classroom)}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Desktop View (Table) */}
                   <div className="hidden lg:block overflow-hidden">
                     <table className="w-full table-fixed text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50/50 border-b border-slate-100 text-slate-500 text-xs font-bold uppercase tracking-widest">
                          <th className="px-6 py-4 lg:px-8 lg:py-5">Nombre Completo</th>
                          <th className="px-6 py-4 lg:px-8 lg:py-5">Grupo</th>
                          <th className="px-6 py-4 lg:px-8 lg:py-5">Turno</th>
                          <th className="px-6 py-4 lg:px-8 lg:py-5">Aula</th>
                           <th className="w-32 px-3 py-4 xl:px-6 xl:py-5 text-right">Semestre</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rows.map(({ student, assignment }, idx) => (
                          <tr key={idx} className="hover:bg-sky-50/50 transition-colors group animate-fade-in-up" style={{ animationDelay: `${idx * 0.05}s` }}>
                             <td className="break-words px-3 py-5 xl:px-6 xl:py-6 text-slate-800 font-semibold text-base xl:text-lg">{student.name || 'Nombre no registrado'}<span className="mt-1 block break-all font-mono text-xs font-medium text-slate-400">{student.documentHint}</span></td>
                             <td className="break-words px-3 py-5 xl:px-6 xl:py-6 text-slate-600 font-medium">
                               <span className={`inline-block max-w-full break-words px-3 py-1.5 rounded-lg text-sm font-bold tracking-wide ${getGrupoColor(assignment?.group || 'Sin grupo')}`}>{assignment?.group || 'No informado'}</span>
                            </td>
                             <td className="break-words px-3 py-5 xl:px-6 xl:py-6 font-medium">
                               <span className={`inline-flex max-w-full items-center break-words px-3 py-1.5 rounded-full text-xs xl:text-sm font-bold ${getTurnoColor(assignment?.shift)}`}>
                                {assignment?.shift || 'No informado'}
                              </span>
                            </td>
                             <td className="break-words px-3 py-5 xl:px-6 xl:py-6">
                               <span className="inline-flex max-w-full items-center break-words px-3 py-1.5 xl:px-4 rounded-xl text-xs xl:text-sm font-bold bg-sky-100/90 text-blue-800 shadow-sm ring-1 ring-sky-200">
                                {classroomLabel(assignment?.classroom)}
                              </span>
                            </td>
                             <td className="break-words px-3 py-5 xl:px-6 xl:py-6 text-slate-500 font-semibold tracking-wide text-right text-sm xl:text-base">{assignment?.semester === null || assignment?.semester === undefined ? 'Semestre no informado' : `Semestre ${assignment.semester}`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : ['empty', 'validation', 'unavailable'].includes(searchState) ? (
                 <div className="break-words text-center py-16 sm:py-24 bg-white/50 backdrop-blur-xl rounded-2xl sm:rounded-3xl border border-dashed border-slate-300 shadow-sm max-w-3xl mx-auto px-4 animate-fade-in-up">
                  <div className="w-16 h-16 sm:w-20 sm:h-20 mx-auto bg-slate-100 rounded-full flex items-center justify-center mb-4 sm:mb-6 shadow-inner">
                    <svg className="w-8 h-8 sm:w-10 sm:h-10 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-xl sm:text-2xl font-bold text-slate-800">{searchState === 'empty' ? 'No encontramos coincidencias' : searchState === 'validation' ? 'Revisa tu búsqueda' : 'La búsqueda no está disponible'}</h3>
                  <p className="text-slate-500 mt-2 text-base sm:text-lg">{searchState === 'empty' ? 'Verifica el nombre o documento e inténtalo nuevamente.' : searchState === 'validation' ? (searchMode === 'name' ? 'Escribe al menos tres caracteres del nombre.' : 'Ingresa un documento válido.') : 'No pudimos completar la consulta. Inténtalo nuevamente en unos momentos.'}</p>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="py-8 sm:py-12 bg-transparent border-t border-slate-200/50 relative z-10 mt-auto">
        <div className="max-w-7xl min-w-0 mx-auto px-4 sm:px-6 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex flex-col items-center md:items-start gap-2">
            <span className="text-xl font-black italic tracking-tighter text-blue-900 drop-shadow-sm">
              UPDS <span className="font-extrabold text-sky-500 not-italic">Cobija</span>
            </span>
            <p className="text-sm font-medium text-slate-500 text-center md:text-left">
              © {new Date().getFullYear()} Universidad Privada Domingo Savio Sede Cobija.
            </p>
          </div>
          
          <div className="flex items-center gap-4">
            <a 
              href="https://www.facebook.com/share/182KCc4hd7/?mibextid=wwXIfr" 
              target="_blank" 
              rel="noopener noreferrer"
              className="p-3 rounded-full bg-white shadow-sm border border-slate-100 text-blue-800 hover:text-white hover:bg-blue-600 hover:shadow-blue-500/30 hover:scale-110 active:scale-95 transition-all duration-300"
              aria-label="Facebook"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path fillRule="evenodd" d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z" clipRule="evenodd" />
              </svg>
            </a>
            <a 
              href="https://www.instagram.com/upds_cobija?igsh=bmRqdXFkN2FwNTYy" 
              target="_blank" 
              rel="noopener noreferrer"
              className="p-3 rounded-full bg-white shadow-sm border border-slate-100 text-pink-600 hover:text-white hover:bg-gradient-to-tr hover:from-yellow-500 hover:via-pink-500 hover:to-purple-600 hover:shadow-pink-500/30 hover:border-transparent hover:scale-110 active:scale-95 transition-all duration-300"
              aria-label="Instagram"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path fillRule="evenodd" d="M12.315 2c2.43 0 2.784.013 3.808.06 1.064.049 1.791.218 2.427.465a4.902 4.902 0 011.772 1.153 4.902 4.902 0 011.153 1.772c.247.636.416 1.363.465 2.427.048 1.067.06 1.407.06 4.123v.08c0 2.643-.012 2.987-.06 4.043-.049 1.064-.218 1.791-.465 2.427a4.902 4.902 0 01-1.153 1.772 4.902 4.902 0 01-1.772 1.153c-.636.247-1.363.416-2.427.465-1.067.048-1.407.06-4.123.06h-.08c-2.643 0-2.987-.012-4.043-.06-1.064-.049-1.791-.218-2.427-.465a4.902 4.902 0 01-1.772-1.153 4.902 4.902 0 01-1.153-1.772c-.247-.636-.416-1.363-.465-2.427-.047-1.024-.06-1.379-.06-3.808v-.63c0-2.43.013-2.784.06-3.808.049-1.064.218-1.791.465-2.427a4.902 4.902 0 011.153-1.772A4.902 4.902 0 015.45 2.525c.636-.247 1.363-.416 2.427-.465C8.901 2.013 9.256 2 11.685 2h.63zm-.081 1.802h-.468c-2.456 0-2.784.011-3.807.058-.975.045-1.504.207-1.857.344-.467.182-.8.398-1.15.748-.35.35-.566.683-.748 1.15-.137.353-.3.882-.344 1.857-.047 1.023-.058 1.351-.058 3.807v.468c0 2.456.011 2.784.058 3.807.045.975.207 1.504.344 1.857.182.466.399.8.748 1.15.35.35.683.566 1.15.748.353.137.882.3 1.857.344 1.054.048 1.37.058 4.041.058h.08c2.597 0 2.917-.01 3.96-.058.976-.045 1.505-.207 1.858-.344.466-.182.8-.398 1.15-.748.35-.35.566-.683.748-1.15.137-.353.3-.882.344-1.857.048-1.055.058-1.37.058-4.041v-.08c0-2.597-.01-2.917-.058-3.96-.045-.976-.207-1.505-.344-1.858a3.097 3.097 0 00-.748-1.15 3.098 3.098 0 00-1.15-.748c-.353-.137-.882-.3-1.857-.344-1.023-.047-1.351-.058-3.807-.058zM12 6.865a5.135 5.135 0 110 10.27 5.135 5.135 0 010-10.27zm0 1.802a3.333 3.333 0 100 6.666 3.333 3.333 0 000-6.666zm5.338-3.205a1.2 1.2 0 110 2.4 1.2 1.2 0 010-2.4z" clipRule="evenodd" />
              </svg>
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
