import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount} from '@vue/test-utils'
import {nextTick} from 'vue'
import {createI18n} from 'vue-i18n'
import {createPinia, setActivePinia} from 'pinia'
import en from '@/i18n/en.js'

const emailCalendarPreview = vi.fn()
const routerBack = vi.fn()

vi.mock('element-plus', () => ({
  ElMessage: vi.fn(),
  ElMessageBox: {confirm: vi.fn()},
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({back: routerBack}),
}))

vi.mock('@/request/email.js', () => ({
  emailCalendarPreview,
  emailDelete: vi.fn(),
  emailRead: vi.fn(),
}))

vi.mock('@/request/star.js', () => ({starAdd: vi.fn(), starCancel: vi.fn()}))
vi.mock('@/request/all-email.js', () => ({allEmailDelete: vi.fn()}))
vi.mock('@/store/user.js', () => ({
  useUserStore: () => ({
    user: {email: 'owner@example.com', ownedEmails: ['owner@example.com']},
  }),
}))

let ContentView
let useEmailStore
let useUiStore

function calendarEnvelope() {
  return {
    schemaVersion: 2,
    parserVersion: 'ical.js/2.2.1',
    state: 'parsed',
    sources: [],
    warnings: [],
    truncated: {parts: false, events: false, envelope: false},
    omittedPartCount: 0,
    omittedEventCount: 0,
    events: [{
      uid: 'teams-1',
      recurrenceId: null,
      sequence: 0,
      action: 'invitation',
      status: 'CONFIRMED',
      summary: 'Teams planning update',
      description: '',
      location: 'Online',
      organizer: {name: 'Jianfeng Jin', address: 'jianfeng.jin@example.com'},
      attendees: [],
      omittedAttendeeCount: 0,
      start: {kind: 'utc', value: '2026-09-01T08:00:00Z', timezone: 'UTC', instant: '2026-09-01T08:00:00.000Z'},
      end: {kind: 'utc', value: '2026-09-01T09:00:00Z', timezone: 'UTC', instant: '2026-09-01T09:00:00.000Z'},
      meetingLink: {
        url: 'https://teams.microsoft.com/meet/123',
        hostname: 'teams.microsoft.com',
        trust: 'trusted',
        provider: 'microsoft-teams',
      },
    }],
  }
}

function briefEmail(overrides = {}) {
  return {
    emailId: 42,
    subject: 'Teams planning update',
    name: 'Jianfeng Jin',
    sendEmail: 'jianfeng.jin@example.com',
    recipient: '[]',
    createTime: '2026-09-01 08:00:00',
    hasCalendar: 1,
    attList: [],
    content: '',
    text: '',
    unread: 0,
    ...overrides,
  }
}

function mountContent(email) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useEmailStore(pinia)
  store.contentData.email = email
  const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})
  const wrapper = mount(ContentView, {
    global: {
      plugins: [pinia, i18n],
      directives: {perm: () => {}},
      stubs: {
        Icon: true,
        ShadowHtml: true,
        'el-alert': true,
        'el-button': {template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>'},
        'el-image-viewer': true,
        'el-scrollbar': {template: '<div><slot /></div>'},
      },
    },
  })
  return {pinia, store, wrapper}
}

beforeAll(async () => {
  setActivePinia(createPinia())
  ContentView = (await import('./index.vue')).default
  useEmailStore = (await import('@/store/email.js')).useEmailStore
  useUiStore = (await import('@/store/ui.js')).useUiStore
})

beforeEach(() => {
  setActivePinia(createPinia())
  emailCalendarPreview.mockReset()
  routerBack.mockReset()
  localStorage.clear()
})

describe('calendar preview from selected brief email', () => {
  it('loads a Teams card before hydration and retains the ICS attachment after hydration', async () => {
    emailCalendarPreview.mockResolvedValue(calendarEnvelope())
    const brief = briefEmail()
    const {store, wrapper} = mountContent(brief)

    await flushPromises()
    expect(emailCalendarPreview).toHaveBeenCalledTimes(1)
    expect(emailCalendarPreview).toHaveBeenCalledWith(42)
    expect(wrapper.get('[data-testid=calendar-preview]').text()).toContain('Teams planning update')
    expect(wrapper.get('a.calendar-event__join').attributes('href')).toBe('https://teams.microsoft.com/meet/123')

    store.applyFullList([{
      ...brief,
      attList: [{attId: 1, key: 'mail/42/invite.ics', filename: 'invite.ics', size: 512}],
    }])
    await nextTick()

    expect(wrapper.text()).toContain('invite.ics')
    expect(emailCalendarPreview).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not request or render a calendar preview for ordinary brief email', async () => {
    const {wrapper} = mountContent(briefEmail({emailId: 43, hasCalendar: 0}))

    await flushPromises()

    expect(emailCalendarPreview).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid=calendar-preview]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the existing retry state when a marked brief email preview is unavailable', async () => {
    emailCalendarPreview.mockRejectedValue({response: {status: 503}})
    const {wrapper} = mountContent(briefEmail({emailId: 44}))

    await flushPromises()

    expect(wrapper.get('[data-testid=calendar-preview]').text()).toContain('temporarily unavailable')
    expect(wrapper.get('.calendar-preview__retry').text()).toBe('Retry')
    await wrapper.get('.calendar-preview__retry').trigger('click')
    expect(emailCalendarPreview).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })
})

describe('recipient details and Reply All', () => {
  it('keeps BCC private on received mail and starts Reply All with only visible peers', async () => {
    const email = briefEmail({
      emailId: 55,
      hasCalendar: 0,
      type: 0,
      sendEmail: 'organizer@example.net',
      recipient: JSON.stringify([
        {address: 'owner@example.com', name: 'Owner'},
        {address: 'peer@example.net', name: 'Peer'},
      ]),
      cc: JSON.stringify([{address: 'copy@example.net', name: 'Copy'}]),
      bcc: JSON.stringify([{address: 'blind@example.net', name: 'Blind'}]),
    })
    const {pinia, store, wrapper} = mountContent(email)
    const replyAll = vi.fn()
    useUiStore(pinia).writerRef = {openReplyAll: replyAll}
    store.detailMap[email.emailId] = {...email, content: '<p>Message</p>'}

    await nextTick()

    expect(wrapper.text()).toContain('peer@example.net')
    expect(wrapper.text()).toContain('copy@example.net')
    expect(wrapper.text()).not.toContain('blind@example.net')
    await wrapper.get('[aria-label="Reply all"]').trigger('click')
    expect(replyAll).toHaveBeenCalledWith(expect.objectContaining({
      emailId: email.emailId,
      content: '<p>Message</p>',
    }), {
      to: ['organizer@example.net'],
      cc: ['peer@example.net', 'copy@example.net'],
      bcc: [],
    })
    wrapper.unmount()
  })

  it('shows BCC only on the sender Sent copy', async () => {
    const {wrapper} = mountContent(briefEmail({
      emailId: 56,
      hasCalendar: 0,
      type: 1,
      recipient: JSON.stringify([{address: 'to@example.net', name: 'To'}]),
      cc: JSON.stringify([{address: 'copy@example.net', name: 'Copy'}]),
      bcc: JSON.stringify([{address: 'blind@example.net', name: 'Blind'}]),
    }))

    await nextTick()

    expect(wrapper.text()).toContain('blind@example.net')
    wrapper.unmount()
  })
})
