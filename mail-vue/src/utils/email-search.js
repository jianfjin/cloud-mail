const STORAGE_PREFIX = 'cloud-mail:search:'
const SIZE_UNITS = {KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3}
export const DATE_LIMITS = {day: 365, week: 52, month: 120, year: 10}
const TEXT_FIELDS = ['query', 'from', 'to', 'subject', 'hasWords', 'doesntHave']

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function validAmount(amount, limit) {
  return Number.isInteger(amount) && amount >= 1 && amount <= limit
}

function dateRange(amount, unit, now) {
  const end = new Date(now)
  const start = new Date(now)
  if (unit === 'day') start.setDate(start.getDate() - amount)
  if (unit === 'week') start.setDate(start.getDate() - amount * 7)
  if (unit === 'month') start.setMonth(start.getMonth() - amount)
  if (unit === 'year') start.setFullYear(start.getFullYear() - amount)
  return {start: start.toISOString(), end: end.toISOString()}
}

/**
 * Convert the UI-only advanced-search draft into the Worker search contract.
 * Dates are calculated using local calendar setters before serializing to UTC.
 */
export function normalizeSearchCriteria(draft = {}, now = new Date()) {
  const criteria = {}
  for (const field of TEXT_FIELDS) {
    const value = trimmed(draft[field])
    if (value) criteria[field] = value
  }

  if (['inbox', 'sent', 'starred'].includes(draft.location)) criteria.location = draft.location
  if (draft.hasAttachment === true) criteria.hasAttachment = true

  if (draft.size?.amount !== '' && draft.size?.amount != null) {
    const amount = Number(draft.size.amount)
    const multiplier = SIZE_UNITS[draft.size.unit]
    if (!validAmount(amount, 999999) || !multiplier || !['gt', 'lt'].includes(draft.size.comparator)) {
      throw new Error('Invalid search size')
    }
    criteria.size = {comparator: draft.size.comparator, bytes: amount * multiplier}
  }

  if (draft.date?.amount !== '' && draft.date?.amount != null) {
    const amount = Number(draft.date.amount)
    const unit = draft.date.unit
    if (!validAmount(amount, DATE_LIMITS[unit])) throw new Error('Invalid search date')
    criteria.date = dateRange(amount, unit, now)
  }

  return criteria
}

function randomId() {
  const webCrypto = globalThis.crypto
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID()
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16))
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }
  return null
}

function storage() {
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}probe`, '1')
    sessionStorage.removeItem(`${STORAGE_PREFIX}probe`)
    return sessionStorage
  } catch {
    return null
  }
}

/** Stores canonical criteria in the browser tab and returns an opaque Search route. */
export function createSearchRoute(criteria) {
  const tabStorage = storage()
  const id = randomId()
  if (!tabStorage || !id) return null
  try {
    tabStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(criteria))
    return {name: 'search', query: {search: id}}
  } catch {
    return null
  }
}

export function readSearchCriteria(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(id)) return null
  const tabStorage = storage()
  if (!tabStorage) return null
  try {
    const parsed = JSON.parse(tabStorage.getItem(`${STORAGE_PREFIX}${id}`))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function emptySearchDraft() {
  return {
    query: '', from: '', to: '', subject: '', hasWords: '', doesntHave: '',
    location: 'all', hasAttachment: false,
    size: {comparator: 'gt', amount: '', unit: 'MB'},
    date: {amount: 1, unit: 'day'},
  }
}
