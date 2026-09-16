import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  createSearchRoute,
  normalizeSearchCriteria,
  readSearchCriteria,
} from './email-search.js'

afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

describe('email search criteria codec', () => {
  it('normalizes a UI draft to the API contract with bounded size and local-date UTC range', () => {
    const now = new Date('2026-09-16T10:30:00.000Z')
    expect(normalizeSearchCriteria({
      query: '  invoice  ',
      from: ' sender@example.com ',
      hasAttachment: true,
      size: {comparator: 'gt', amount: 2, unit: 'MB'},
      date: {amount: 1, unit: 'day'},
    }, now)).toEqual({
      query: 'invoice',
      from: 'sender@example.com',
      hasAttachment: true,
      size: {comparator: 'gt', bytes: 2 * 1024 * 1024},
      date: {start: '2026-09-15T10:30:00.000Z', end: '2026-09-16T10:30:00.000Z'},
    })
  })

  it('rejects invalid UI caps and keeps location-only searches valid', () => {
    expect(normalizeSearchCriteria({location: 'sent'})).toEqual({location: 'sent'})
    expect(() => normalizeSearchCriteria({size: {comparator: 'gt', amount: 1_000_000, unit: 'MB'}})).toThrow('size')
    expect(() => normalizeSearchCriteria({date: {amount: 53, unit: 'week'}})).toThrow('date')
  })

  it('stores criteria behind an opaque same-tab key and never exposes criteria in the route', () => {
    vi.stubGlobal('crypto', {randomUUID: () => 'opaque-id'})
    const route = createSearchRoute({query: 'medical appointment', location: 'inbox'})

    expect(route).toEqual({name: 'search', query: {search: 'opaque-id'}})
    expect(JSON.stringify(route)).not.toContain('medical appointment')
    expect(readSearchCriteria('opaque-id')).toEqual({query: 'medical appointment', location: 'inbox'})
  })

  it('returns null safely when session storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      setItem: () => { throw new Error('blocked') },
      getItem: () => { throw new Error('blocked') },
    })
    expect(createSearchRoute({query: 'private'})).toBeNull()
    expect(readSearchCriteria('anything')).toBeNull()
  })
})
