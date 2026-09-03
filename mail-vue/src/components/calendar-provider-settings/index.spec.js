import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {flushPromises, mount} from '@vue/test-utils'
import {createI18n} from 'vue-i18n'
import en from '@/i18n/en.js'

const addCalendarProvider = vi.fn()
const getCalendarProviders = vi.fn()
const updateCalendarProvider = vi.fn()

vi.mock('@/request/calendar.js', () => ({
  addCalendarProvider,
  getCalendarProviders,
  updateCalendarProvider,
}))

let CalendarProviderSettings

const ElInput = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)">',
}

const ElButton = {
  template: '<button><slot /></button>',
}

const ElSwitch = {
  props: ['modelValue'],
  emits: ['change'],
  template: '<input type="checkbox" :checked="modelValue" @change="$emit(\'change\', $event.target.checked)">',
}

function render() {
  const i18n = createI18n({legacy: false, locale: 'en', messages: {en}})
  return mount(CalendarProviderSettings, {
    global: {
      plugins: [i18n],
      stubs: {ElInput, ElButton, ElSwitch},
    },
  })
}

beforeAll(async () => {
  CalendarProviderSettings = (await import('./index.vue')).default
})

beforeEach(() => {
  addCalendarProvider.mockReset()
  getCalendarProviders.mockReset()
  updateCalendarProvider.mockReset()
})

describe('calendar provider settings', () => {
  it('loads providers, creates one, and toggles its enabled state', async () => {
    getCalendarProviders.mockResolvedValue([
      {providerId: 1, host: 'meet.google.com', label: 'Google Meet', enabled: 1},
    ])
    addCalendarProvider.mockResolvedValue({
      providerId: 2, host: 'video.example.test', label: 'Example Video', enabled: 1,
    })
    updateCalendarProvider.mockResolvedValue({
      providerId: 1, host: 'meet.google.com', label: 'Google Meet', enabled: 0,
    })

    const wrapper = render()
    await flushPromises()
    expect(wrapper.text()).toContain('Google Meet')

    const inputs = wrapper.findAll('input')
    await inputs[0].setValue('video.example.test')
    await inputs[1].setValue('Example Video')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(addCalendarProvider).toHaveBeenCalledWith({
      host: 'video.example.test',
      label: 'Example Video',
    })
    expect(wrapper.text()).toContain('Example Video')

    await wrapper.findAll('input[type="checkbox"]')[0].setValue(false)
    await flushPromises()
    expect(updateCalendarProvider).toHaveBeenCalledWith(1, {enabled: false})
  })
})
