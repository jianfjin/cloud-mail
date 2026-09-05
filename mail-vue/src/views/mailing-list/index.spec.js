import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushPromises, mount} from '@vue/test-utils';
import {createI18n} from 'vue-i18n';
import en from '@/i18n/en.js';
import zh from '@/i18n/zh.js';

const mailingListList = vi.fn();

vi.mock('element-plus', () => ({
  ElMessage: {success: vi.fn(), error: vi.fn()},
  ElMessageBox: {confirm: vi.fn()},
}));

vi.mock('@iconify/vue', () => ({
  Icon: {template: '<span />'},
}));

vi.mock('@/request/mailing-list.js', () => ({
  mailingListAddMember: vi.fn(),
  mailingListAddSender: vi.fn(),
  mailingListCreate: vi.fn(),
  mailingListDeleteMember: vi.fn(),
  mailingListDeleteSender: vi.fn(),
  mailingListDetail: vi.fn(),
  mailingListList,
  mailingListMembers: vi.fn(),
  mailingListReports: vi.fn(),
  mailingListRetry: vi.fn(),
  mailingListSenders: vi.fn(),
  mailingListSetState: vi.fn(),
  mailingListUpdate: vi.fn(),
}));

let MailingListView;

const stubs = {
  'el-button': {template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>'},
  'el-dialog': {template: '<div><slot /></div>'},
  'el-empty': true,
  'el-form': {template: '<form><slot /></form>'},
  'el-form-item': {template: '<div><slot /></div>'},
  'el-input': {template: '<input v-bind="$attrs" />'},
  'el-input-number': true,
  'el-option': true,
  'el-select': {template: '<select><slot /></select>'},
  'el-switch': true,
  'el-table': {template: '<div><slot name="empty" /></div>'},
  'el-table-column': true,
  'el-tag': true,
  'el-tooltip': {template: '<span><slot /></span>'},
};

function mountView(locale) {
  const i18n = createI18n({legacy: false, locale, messages: {en, zh}});
  return mount(MailingListView, {
    global: {
      plugins: [i18n],
      directives: {loading: () => {}},
      stubs,
    },
  });
}

beforeAll(async () => {
  MailingListView = (await import('./index.vue')).default;
});

beforeEach(() => {
  mailingListList.mockReset();
  mailingListList.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('mailing-list administration view', () => {
  it('loads the initial list and exposes English search and management labels', async () => {
    const wrapper = mountView('en');
    await flushPromises();

    expect(mailingListList).toHaveBeenCalledWith({search: ''});
    expect(wrapper.get('section[aria-label="Mailing Lists"]').exists()).toBe(true);
    expect(wrapper.get('input[placeholder="Search lists"]').exists()).toBe(true);
    expect(wrapper.get('button[aria-label="New list"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('keeps localized Chinese labels available to assistive technology', async () => {
    const wrapper = mountView('zh');
    await flushPromises();

    expect(wrapper.get('section[aria-label="邮件列表"]').exists()).toBe(true);
    expect(wrapper.get('input[placeholder="搜索列表"]').exists()).toBe(true);
    expect(wrapper.get('button[aria-label="新建列表"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
