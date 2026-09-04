import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import RecipientInput from './index.vue'

describe('recipient input', () => {
  it('exposes typed contact suggestions as keyboard-accessible choices', async () => {
    const wrapper = mount(RecipientInput, {
      props: {
        label: 'Cc',
        suggestions: ['contact@example.com'],
      },
      global: {
        stubs: {
          Icon: true,
          'el-input-tag': {template: '<div><slot name="prefix" /><slot name="suffix" /></div>'},
          'el-button': {template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>'},
        },
      },
    })

    const suggestion = wrapper.get('[aria-label="contact@example.com"]')
    expect(suggestion.text()).toBe('contact@example.com')
    await suggestion.trigger('click')

    expect(wrapper.emitted('suggestion')).toContainEqual(['contact@example.com'])
  })
})
