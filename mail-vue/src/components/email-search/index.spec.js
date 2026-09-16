import {describe, expect, it, vi} from 'vitest'
import {mount} from '@vue/test-utils'

const Search = () => import('./index.vue').then(module => module.default)

function render(props = {}) {
  return mount(props.component, {
    global: {
      mocks: {$t: key => key},
      stubs: {
        Icon: true,
        ElSelect: {template: '<select><slot /></select>'},
        ElOption: true,
        ElCheckbox: {template: '<input type="checkbox" />'},
      },
    },
  })
}

describe('email search header', () => {
  it('does not submit blank quick searches but submits trimmed text with Enter', async () => {
    const component = await Search()
    const wrapper = render({component})
    const input = wrapper.get('[data-testid="email-search-quick"]')
    await input.setValue('   ')
    await input.trigger('keyup.enter')
    expect(wrapper.emitted('search')).toBeFalsy()

    await input.setValue(' receipt ')
    await input.trigger('keyup.enter')
    expect(wrapper.emitted('search')[0]).toEqual([{query: 'receipt'}])
  })

  it('uses a separate advanced draft, supports location-only search, and restores the opener on Escape', async () => {
    const component = await Search()
    const wrapper = render({component})
    const trigger = wrapper.get('[data-testid="email-search-advanced"]')
    const focus = vi.spyOn(trigger.element, 'focus')
    await trigger.trigger('click')
    expect(wrapper.get('[data-testid="email-search-panel"]').attributes('aria-hidden')).toBe('false')

    await wrapper.get('[data-testid="email-search-date-enabled"]').setValue(false)
    await wrapper.get('[data-testid="email-search-location"]').setValue('sent')
    await wrapper.get('[data-testid="email-search-submit"]').trigger('click')
    expect(wrapper.emitted('search')[0]).toEqual([{location: 'sent'}])

    await trigger.trigger('click')
    await wrapper.trigger('keydown', {key: 'Escape'})
    expect(wrapper.get('[data-testid="email-search-panel"]').attributes('aria-hidden')).toBe('true')
    expect(focus).toHaveBeenCalled()
  })
})
