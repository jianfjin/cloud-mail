import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {flushPromises, mount} from '@vue/test-utils';
import {createI18n} from 'vue-i18n';
import en from '@/i18n/en.js';
import zh from '@/i18n/zh.js';

const mailingListList = vi.fn();
const mailingListDetail = vi.fn();
const mailingListMembers = vi.fn();
const mailingListReport = vi.fn();
const mailingListReports = vi.fn();
const mailingListSenders = vi.fn();

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
  mailingListDetail,
  mailingListList,
  mailingListMembers,
  mailingListReport,
  mailingListReports,
  mailingListRetry: vi.fn(),
  mailingListSenders,
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
  'el-table': {
    props: ['data'],
    emits: ['row-click'],
    template: '<div><button v-for="row in data" class="table-row" @click="$emit(\'row-click\', row)">{{ row.display_name }}</button><slot name="empty" /></div>',
  },
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
  mailingListDetail.mockReset();
  mailingListMembers.mockReset();
  mailingListReport.mockReset();
  mailingListReports.mockReset();
  mailingListSenders.mockReset();
  mailingListList.mockResolvedValue([]);
  mailingListMembers.mockResolvedValue([]);
  mailingListReport.mockResolvedValue(null);
  mailingListReports.mockResolvedValue([]);
  mailingListSenders.mockResolvedValue([]);
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

  it('shows the selected list member count against its effective cap', async () => {
    const list = {
      list_id: 7,
      address: 'team@example.com',
      display_name: 'Team',
      state: 'enabled',
      posting_policy: 'members',
      reply_policy: 'sender',
      self_delivery: 1,
      member_limit: null,
      daily_post_limit: null,
      effectiveMemberLimit: 3,
      effectiveDailyPostLimit: 100,
    };
    mailingListList.mockResolvedValue([list]);
    mailingListDetail.mockResolvedValue(list);
    mailingListMembers.mockResolvedValue([{member_id: 1, email: 'member@example.net'}]);
    const wrapper = mountView('en');
    await flushPromises();
    await wrapper.get('button.table-row').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Members (1 / 3)');
    wrapper.unmount();
  });

  it('loads recipient outcomes only after an administrator opens a report', async () => {
    const list = {
      list_id: 7,
      address: 'team@example.com',
      display_name: 'Team',
      state: 'enabled',
      posting_policy: 'members',
      reply_policy: 'sender',
      self_delivery: 1,
      member_limit: null,
      daily_post_limit: null,
      effectiveMemberLimit: 3,
      effectiveDailyPostLimit: 100,
    };
    mailingListList.mockResolvedValue([list]);
    mailingListDetail.mockResolvedValue(list);
    mailingListReports.mockResolvedValue([{
      postId: 11,
      sender: 'sender@example.net',
      acceptedAt: '2026-09-05 10:00:00',
      totals: {delivered: 1, failed: 0, queued: 0, processing: 0, pending: 0, skipped: 0},
    }]);
    mailingListReport.mockResolvedValue({
      postId: 11,
      outcomes: [{deliveryId: 5, state: 'delivered', safeReason: ''}],
      totals: {delivered: 1, failed: 0, queued: 0, processing: 0, pending: 0, skipped: 0},
    });
    const wrapper = mountView('en');
    await flushPromises();
    await wrapper.get('button.table-row').trigger('click');
    await flushPromises();

    expect(mailingListReport).not.toHaveBeenCalled();
    await wrapper.findAll('button.table-row')[1].trigger('click');
    await flushPromises();

    expect(mailingListReport).toHaveBeenCalledWith(7, 11);
    wrapper.unmount();
  });
});
