import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount} from '@vue/test-utils'
import {createI18n} from 'vue-i18n'
import {createPinia, setActivePinia} from 'pinia'
import en from '@/i18n/en.js'

const push = vi.fn()
const route = {query: {search: 'opaque-search-token'}, name: 'search'}
const emailSearch = vi.fn()
const emailSearchDetails = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({push}),
}))
vi.mock('@/request/email.js', () => ({emailSearch, emailSearchDetails, emailDelete: vi.fn(), emailRead: vi.fn()}))
vi.mock('@/request/star.js', () => ({starAdd: vi.fn(), starCancel: vi.fn()}))
vi.mock('@/utils/email-search.js', async importOriginal => ({
  ...(await importOriginal()),
  readSearchCriteria: vi.fn(() => ({query: 'invoice'})),
}))

let SearchView
let readSearchCriteria

function mountSearch() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})
  return mount(SearchView, {
    global: {
      plugins: [pinia, i18n],
      directives: {perm: () => {}},
      stubs: {Icon: true},
    },
  })
}

beforeAll(async () => {
  SearchView = (await import('./index.vue')).default
  readSearchCriteria = (await import('@/utils/email-search.js')).readSearchCriteria
})

beforeEach(() => {
  push.mockReset()
  emailSearch.mockReset()
  emailSearchDetails.mockReset()
  readSearchCriteria.mockReset()
  readSearchCriteria.mockReturnValue({query: 'invoice'})
  route.query.search = 'opaque-search-token'
  emailSearch.mockImplementation(payload => Promise.resolve({generation: payload.generation, list: [{emailId: 9, type: 0, subject: 'Invoice'}], nextCursor: 9, total: 1}))
  emailSearchDetails.mockImplementation(payload => Promise.resolve({generation: payload.generation, list: [{emailId: 9, type: 0, subject: 'Invoice', content: '<p>Full</p>', attList: []}]}))
})

describe('search results', () => {
  it('uses opaque session criteria, hydrates result details, and opens content with received capabilities', async () => {
    const wrapper = mountSearch()
    await flushPromises()

    expect(emailSearch).toHaveBeenCalledWith(expect.objectContaining({criteria: {query: 'invoice'}, order: 'newest'}))
    expect(emailSearchDetails).toHaveBeenCalledWith(expect.objectContaining({emailIds: [9]}))
    expect(wrapper.text()).toContain('1 result')

    await wrapper.get('[data-testid="search-result-9"]').trigger('click')
    expect(push).toHaveBeenCalledWith({name: 'content'})
    wrapper.unmount()
  })

  it('does not call the API when its opaque session record is absent', async () => {
    readSearchCriteria.mockReturnValue(null)
    const wrapper = mountSearch()
    await flushPromises()

    expect(emailSearch).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('search is no longer available')
    wrapper.unmount()
  })

  it('keeps stale result responses from replacing the current search', async () => {
    let resolveFirst
    emailSearch.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
    const wrapper = mountSearch()
    await flushPromises()
    await wrapper.get('[data-testid="search-order"]').setValue('oldest')
    resolveFirst({generation: 2, list: [{emailId: 1, subject: 'stale'}], nextCursor: null, total: 1})
    await flushPromises()

    expect(emailSearch).toHaveBeenLastCalledWith(expect.objectContaining({order: 'oldest'}))
    expect(wrapper.text()).not.toContain('stale')
    wrapper.unmount()
  })
})
