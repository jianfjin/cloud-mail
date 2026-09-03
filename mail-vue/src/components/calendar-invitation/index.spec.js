import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount} from '@vue/test-utils'
import {createApp, nextTick} from 'vue'
import {createI18n} from 'vue-i18n'
import {createPinia, setActivePinia} from 'pinia'
import piniaPersistedState from 'pinia-plugin-persistedstate'
import en from '@/i18n/en.js'

const confirm = vi.fn()
const emailCalendarPreview = vi.fn()
const emailCalendarEligibility = vi.fn()
const emailCalendarResponse = vi.fn()
const emailCalendarResponseRetry = vi.fn()

vi.mock('element-plus', async importOriginal => ({
  ...await importOriginal(),
  ElMessageBox: {confirm},
}))

vi.mock('@/request/email.js', () => ({
  emailCalendarPreview,
  emailCalendarEligibility,
  emailCalendarResponse,
  emailCalendarResponseRetry,
}))

let CalendarInvitation
let useEmailStore

function envelope(events = [], state = 'parsed') {
  return {
    schemaVersion: 2,
    parserVersion: 'ical.js/2.2.1',
    state,
    sources: [],
    events,
    warnings: [],
    truncated: {parts: false, events: false, envelope: false},
    omittedPartCount: 0,
    omittedEventCount: 0,
  }
}

function event(overrides = {}) {
  return {
    uid: 'event-1@example.com',
    recurrenceId: null,
    sequence: 0,
    action: 'invitation',
    status: 'CONFIRMED',
    summary: 'Planning call',
    description: 'First line\nSecond line',
    location: 'Online',
    organizer: {name: 'Zoë Example', address: 'zoe@example.com'},
    attendees: [{name: 'Renée', address: 'renee@example.com', participationStatus: 'TENTATIVE'}],
    omittedAttendeeCount: 0,
    start: {kind: 'utc', value: '2026-09-01T08:00:00Z', timezone: 'UTC', instant: '2026-09-01T08:00:00.000Z'},
    end: {kind: 'utc', value: '2026-09-01T09:00:00Z', timezone: 'UTC', instant: '2026-09-01T09:00:00.000Z'},
    meetingLink: {
      url: 'https://meet.google.com/abc-defg-hij',
      hostname: 'meet.google.com',
      trust: 'trusted',
      provider: 'google-meet',
    },
    ...overrides,
  }
}

function render(props = {}) {
  const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})
  return mount(CalendarInvitation, {
    props: {emailId: 99, accountId: 11, envelope: envelope([event()]), requestState: 'success', ...props},
    global: {plugins: [i18n]},
  })
}

beforeAll(async () => {
  setActivePinia(createPinia())
  CalendarInvitation = (await import('./index.vue')).default
  useEmailStore = (await import('@/store/email.js')).useEmailStore
})

beforeEach(() => {
  setActivePinia(createPinia())
  confirm.mockReset()
  emailCalendarPreview.mockReset()
  emailCalendarEligibility.mockReset()
  emailCalendarResponse.mockReset()
  emailCalendarResponseRetry.mockReset()
  emailCalendarEligibility.mockResolvedValue({eligible: false})
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('calendar invitation', () => {
  it('renders bodyless Google and Teams invitations with explicit time, organizer, and safe keyboard links', () => {
    const wrapper = render({
      envelope: envelope([
        event(),
        event({
          uid: 'teams',
          summary: 'Teams planning update',
          action: 'update',
          sequence: 2,
          start: {kind: 'zoned', value: '2026-09-01T10:00:00', timezone: 'Europe/Amsterdam', instant: '2026-09-01T08:00:00.000Z'},
          end: {kind: 'zoned', value: '2026-09-01T11:00:00', timezone: 'Europe/Amsterdam', instant: '2026-09-01T09:00:00.000Z'},
          meetingLink: {url: 'https://teams.microsoft.com/meet/123', hostname: 'teams.microsoft.com', trust: 'trusted', provider: 'microsoft-teams'},
        }),
      ]),
    })

    expect(wrapper.text()).toContain('Planning call')
    expect(wrapper.text()).toContain('Teams planning update')
    expect(wrapper.text()).toContain('Zoë Example <zoe@example.com>')
    expect(wrapper.text()).toContain('Shown in')
    const links = wrapper.findAll('a.calendar-event__join')
    expect(links).toHaveLength(2)
    expect(links[0].attributes()).toMatchObject({
      href: 'https://meet.google.com/abc-defg-hij',
      target: '_blank',
      rel: 'noopener noreferrer',
      referrerpolicy: 'no-referrer',
    })
    expect(links[1].text()).toContain('teams.microsoft.com')
  })

  it('labels invitations, updates, whole-event cancellations, and occurrence cancellations as sender-declared without RSVP controls', () => {
    const wrapper = render({
      envelope: envelope([
        event({uid: 'initial'}),
        event({uid: 'update', action: 'update', sequence: 2}),
        event({uid: 'cancel', action: 'cancellation', status: 'CANCELLED'}),
        event({uid: 'instance', action: 'cancellation', status: 'CANCELLED', recurrenceId: '2026-09-08T08:00:00Z'}),
      ]),
    })

    expect(wrapper.text()).toContain('Invitation · sender-declared')
    expect(wrapper.text()).toContain('Event update · sender-declared')
    expect(wrapper.text()).toContain('Event cancellation · sender-declared')
    expect(wrapper.text()).toContain('Occurrence cancellation · sender-declared')
    expect(wrapper.text()).not.toMatch(/accept|decline|rsvp/i)
  })

  it('uses API-declared eligibility to confirm and send an RSVP for the selected account', async () => {
    emailCalendarEligibility.mockResolvedValue({
      eligible: true,
      organizer: {name: 'Zoe Example', address: 'zoe@example.com'},
      account: {accountId: 11, email: 'local-tester@example.com'},
      responses: [],
    })
    emailCalendarResponse.mockResolvedValue({
      responseId: 7,
      participationStatus: 'ACCEPTED',
      deliveryState: 'delivered',
    })
    confirm.mockResolvedValue()
    const wrapper = render()
    await flushPromises()

    const accept = wrapper.get('[data-testid="calendar-rsvp-ACCEPTED"]')
    expect(wrapper.text()).toContain('Accept')
    await accept.trigger('click')
    await flushPromises()

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('zoe@example.com'), expect.any(Object))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('local-tester@example.com'), expect.any(Object))
    expect(emailCalendarResponse).toHaveBeenCalledWith({
      emailId: 99,
      eventUid: 'event-1@example.com',
      recurrenceId: null,
      accountId: 11,
      participationStatus: 'ACCEPTED',
    })
    expect(wrapper.text()).toContain('Delivered')
  })

  it('announces dispatching and exposes retry only for confirmed no-send outcomes', async () => {
    emailCalendarEligibility.mockResolvedValue({
      eligible: true,
      organizer: {name: 'Zoe Example', address: 'zoe@example.com'},
      account: {accountId: 11, email: 'local-tester@example.com'},
      responses: [
        {responseId: 5, participationStatus: 'TENTATIVE', deliveryState: 'retryable_no_send'},
        {responseId: 6, participationStatus: 'DECLINED', deliveryState: 'delivery_unknown'},
      ],
    })
    let resolveResponse
    emailCalendarResponse.mockReturnValue(new Promise(resolve => {
      resolveResponse = resolve
    }))
    emailCalendarResponseRetry.mockResolvedValue({
      responseId: 5,
      participationStatus: 'TENTATIVE',
      deliveryState: 'delivered',
    })
    confirm.mockResolvedValue()
    const wrapper = render()
    await flushPromises()

    await wrapper.get('[data-testid="calendar-rsvp-ACCEPTED"]').trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('Sending')
    expect(wrapper.get('[data-testid="calendar-rsvp-ACCEPTED"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="calendar-rsvp-retry-5"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="calendar-rsvp-retry-6"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Delivery status unknown')

    resolveResponse({
      responseId: 7,
      participationStatus: 'ACCEPTED',
      deliveryState: 'delivered',
    })
    await flushPromises()
    await wrapper.get('[data-testid="calendar-rsvp-retry-5"]').trigger('click')
    await flushPromises()

    expect(emailCalendarResponseRetry).toHaveBeenCalledWith({responseId: 5})
    expect(wrapper.text()).toContain('Tentative: Delivered')
  })

  it('uses trusted registry output for custom providers without hard-coded host allowlists', () => {
    const wrapper = render({
      envelope: envelope([event({meetingLink: {
        url: 'https://video.example.net/room/123',
        hostname: 'video.example.net',
        trust: 'trusted',
        provider: 'Example Video',
      }})]),
    })

    expect(wrapper.get('a.calendar-event__join').attributes('href')).toBe('https://video.example.net/room/123')
  })

  it('keeps UTC/zoned conversions explicit and never converts floating, unresolved, or all-day values', () => {
    const wrapper = render({
      envelope: envelope([
        event({uid: 'utc'}),
        event({uid: 'zoned', start: {kind: 'zoned', value: '2026-09-01T10:00:00', timezone: 'Test/PlusTwo', instant: '2026-09-01T08:00:00.000Z'}}),
        event({uid: 'floating', start: {kind: 'floating', value: '2026-09-01T10:00:00', timezone: null, instant: null}, end: null}),
        event({uid: 'unknown', start: {kind: 'unresolved', value: '2026-09-01T10:00:00', timezone: 'Mars/Olympus', instant: null}, end: null}),
        event({uid: 'all-day', start: {kind: 'all-day', value: '2026-09-01', timezone: null, instant: null}, end: {kind: 'all-day', value: '2026-09-02', timezone: null, instant: null}}),
      ]),
    })

    expect(wrapper.text()).toContain('source time zone Test/PlusTwo')
    expect(wrapper.text()).toContain('Floating time; no time zone was supplied')
    expect(wrapper.text()).toContain('time zone Mars/Olympus could not be resolved')
    expect(wrapper.text()).toContain('All day; dates shown as sent')
  })

  it.each([
    ['partial', 'Some invitation details could not be read'],
    ['unsupported', 'does not contain a supported event'],
    ['failed', 'could not be read safely'],
  ])('shows a non-empty %s fallback', (state, message) => {
    const wrapper = render({envelope: envelope([], state)})
    expect(wrapper.text()).toContain(message)
    expect(wrapper.text()).toContain('No event details are available')
  })

  it('shows loading, retryable, terminal, and unknown-version states with a retry control', async () => {
    const loading = render({envelope: null, requestState: 'loading'})
    expect(loading.text()).toContain('Loading invitation details')

    const retryable = render({envelope: null, requestState: 'retryable'})
    await retryable.get('button').trigger('click')
    expect(retryable.emitted('retry')).toHaveLength(1)

    const terminal = render({envelope: null, requestState: 'terminal'})
    expect(terminal.text()).toContain('not available for this message')

    const future = render({envelope: {...envelope([]), schemaVersion: 999}})
    expect(future.text()).toContain('newer or unsupported calendar parser')
  })

  it('renders calendar text literally and rejects deceptive or unsafe meeting URLs', () => {
    const unsafe = [
      '//meet.google.com/room',
      'https://user:pass@meet.google.com/room',
      'https://meet.google.com@evil.example/room',
      `https://example.com/${'x'.repeat(2050)}`,
      'https://example.com/line\nbreak',
      'javascript:alert(1)',
    ]
    const wrapper = render({
      envelope: envelope([
        event({summary: '<img src=x onerror=alert(1)>', description: '<script>alert(1)</script>'}),
        ...unsafe.map((url, index) => event({uid: `unsafe-${index}`, meetingLink: {url, trust: 'trusted', provider: 'google-meet'}})),
      ]),
    })

    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>')
    expect(wrapper.text()).toContain('<script>alert(1)</script>')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.findAll('.calendar-event__join')).toHaveLength(1)
  })

  it('shows the parsed hostname and confirms before opening an unverified HTTPS link', async () => {
    confirm.mockResolvedValue()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const wrapper = render({
      envelope: envelope([event({meetingLink: {
        url: 'https://video.example.net/room/123',
        hostname: 'spoofed.example',
        trust: 'unverified',
        provider: null,
      }})]),
    })

    const button = wrapper.get('button.calendar-event__join--unverified')
    expect(button.text()).toContain('video.example.net')
    expect(wrapper.find('a.calendar-event__join').exists()).toBe(false)
    await button.trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('video.example.net'), expect.any(Object))
    expect(open).toHaveBeenCalledWith('https://video.example.net/room/123', '_blank', 'noopener,noreferrer')
  })
})

describe('calendar preview state', () => {
  it('deduplicates historical preview requests and keeps keyed stale responses isolated', async () => {
    let resolveRequest
    emailCalendarPreview.mockReturnValue(new Promise(resolve => { resolveRequest = resolve }))
    const store = useEmailStore()
    const first = store.fetchCalendarPreview({emailId: 10})
    const second = store.fetchCalendarPreview({emailId: 10})
    store.calendarPreviewMap[11] = {status: 'success', envelope: envelope([event({uid: 'new-message'})])}

    expect(emailCalendarPreview).toHaveBeenCalledTimes(1)
    resolveRequest(envelope([event({uid: 'old-message'})]))
    await first
    expect(store.calendarPreviewMap[10].envelope.events[0].uid).toBe('old-message')
    expect(store.calendarPreviewMap[11].envelope.events[0].uid).toBe('new-message')

    await store.fetchCalendarPreview({emailId: 10})
    expect(emailCalendarPreview).toHaveBeenCalledTimes(1)
  })

  it('does not persist organizer, attendees, description, or meeting URL in browser storage', async () => {
    const pinia = createPinia().use(piniaPersistedState)
    const app = createApp({template: '<div />'})
    app.use(pinia)
    const host = document.createElement('div')
    document.body.appendChild(host)
    app.mount(host)
    const store = useEmailStore(pinia)
    store.contentData.email = {emailId: 1, subject: 'Safe subject'}
    store.calendarPreviewMap[1] = {status: 'success', envelope: envelope([event()])}
    await nextTick()

    const persisted = localStorage.getItem('email') || ''
    expect(persisted).toContain('Safe subject')
    expect(persisted).not.toContain('zoe@example.com')
    expect(persisted).not.toContain('renee@example.com')
    expect(persisted).not.toContain('First line')
    expect(persisted).not.toContain('meet.google.com')
    app.unmount()
    host.remove()
  })
})
