<template>
  <main class="mailing-list">
    <header class="toolbar">
      <div class="toolbar__search">
        <el-input v-model="search" :placeholder="$t('mailingListSearch')" clearable @keyup.enter="loadLists"/>
      </div>
      <el-tooltip :content="$t('mailingListAdd')" placement="bottom">
        <el-button circle type="primary" :aria-label="$t('mailingListAdd')" @click="openCreate">
          <Icon icon="ion:add-outline" width="20"/>
        </el-button>
      </el-tooltip>
      <el-tooltip :content="$t('reset')" placement="bottom">
        <el-button circle :aria-label="$t('reset')" :loading="loading" @click="loadLists">
          <Icon icon="ion:reload" width="18"/>
        </el-button>
      </el-tooltip>
    </header>

    <section class="list-region" :aria-label="$t('mailingLists')">
      <el-table v-loading="loading" :data="lists" row-key="list_id" @row-click="selectList">
        <el-table-column prop="display_name" :label="$t('mailingListDisplayName')" min-width="160"/>
        <el-table-column prop="address" :label="$t('mailingListAddress')" min-width="220" show-overflow-tooltip/>
        <el-table-column :label="$t('mailingListState')" width="128">
          <template #default="{row}">
            <el-tag :type="stateType(row.state)">{{ stateLabel(row.state) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="$t('mailingListEffectiveLimit')" min-width="150">
          <template #default="{row}">{{ row.effectiveMemberLimit }} / {{ row.effectiveDailyPostLimit }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && lists.length === 0" :description="$t('mailingLists')"/>
    </section>

    <section v-if="selected" class="inspector" :aria-label="selected.address">
      <div class="inspector__head">
        <div>
          <h2>{{ selected.display_name }}</h2>
          <p>{{ selected.address }}</p>
        </div>
        <el-select v-model="selected.state" class="state-select" @change="changeState">
          <el-option value="enabled" :label="$t('mailingListEnabled')"/>
          <el-option value="disabled" :label="$t('mailingListDisabled')"/>
          <el-option value="retired" :label="$t('mailingListRetired')"/>
        </el-select>
      </div>

      <el-form label-position="top" class="policy-grid">
        <el-form-item :label="$t('mailingListDisplayName')">
          <el-input v-model="editor.displayName"/>
        </el-form-item>
        <el-form-item :label="$t('mailingListPostingPolicy')">
          <el-select v-model="editor.postingPolicy">
            <el-option value="members" :label="$t('mailingListMembersOnly')"/>
            <el-option value="allowlist" :label="$t('mailingListAllowlist')"/>
            <el-option value="public" :label="$t('mailingListPublic')"/>
          </el-select>
        </el-form-item>
        <el-form-item :label="$t('mailingListReplyPolicy')">
          <el-select v-model="editor.replyPolicy">
            <el-option value="sender" :label="$t('mailingListReplySender')"/>
            <el-option value="list" :label="$t('mailingListReplyList')"/>
          </el-select>
        </el-form-item>
        <el-form-item :label="$t('mailingListMemberLimit')">
          <el-input-number v-model="editor.memberLimit" :min="1" controls-position="right"/>
        </el-form-item>
        <el-form-item :label="$t('mailingListDailyLimit')">
          <el-input-number v-model="editor.dailyPostLimit" :min="1" controls-position="right"/>
        </el-form-item>
        <el-form-item :label="$t('mailingListSelfDelivery')" class="toggle-field">
          <el-switch v-model="editor.selfDelivery"/>
        </el-form-item>
      </el-form>
      <div class="inspector__actions">
        <el-button type="primary" :loading="saving" @click="saveEditor">{{ $t('save') }}</el-button>
      </div>

      <div class="operations-grid">
        <section class="operation">
          <h3>{{ $t('mailingListMembers') }}</h3>
          <div class="add-line">
            <el-input v-model="memberEmail" type="email" :placeholder="$t('emailAccount')" @keyup.enter="addMember"/>
            <el-button type="primary" @click="addMember">{{ $t('mailingListAddMember') }}</el-button>
          </div>
          <el-table :data="members" size="small">
            <el-table-column prop="email" :label="$t('emailAccount')" show-overflow-tooltip/>
            <el-table-column :label="$t('action')" width="64" align="right">
              <template #default="{row}">
                <el-tooltip :content="$t('delete')">
                  <el-button circle text type="danger" :aria-label="$t('delete')" @click="removeMember(row)">
                    <Icon icon="fluent:delete-20-regular" width="18"/>
                  </el-button>
                </el-tooltip>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="members.length === 0" :image-size="64" :description="$t('mailingListNoMembers')"/>
        </section>

        <section class="operation">
          <h3>{{ $t('mailingListSenders') }}</h3>
          <div class="add-line">
            <el-input v-model="senderEmail" type="email" :placeholder="$t('emailAccount')" @keyup.enter="addSender"/>
            <el-button type="primary" @click="addSender">{{ $t('mailingListAddSender') }}</el-button>
          </div>
          <el-table :data="senders" size="small">
            <el-table-column prop="email" :label="$t('emailAccount')" show-overflow-tooltip/>
            <el-table-column :label="$t('action')" width="64" align="right">
              <template #default="{row}">
                <el-tooltip :content="$t('delete')">
                  <el-button circle text type="danger" :aria-label="$t('delete')" @click="removeSender(row)">
                    <Icon icon="fluent:delete-20-regular" width="18"/>
                  </el-button>
                </el-tooltip>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="senders.length === 0" :image-size="64" :description="$t('mailingListNoSenders')"/>
        </section>
      </div>

      <section class="reports">
        <h3>{{ $t('mailingListReports') }}</h3>
        <el-table :data="reports" size="small" @row-click="openReport">
          <el-table-column prop="acceptedAt" :label="$t('mailingListAcceptedAt')" min-width="160"/>
          <el-table-column prop="sender" :label="$t('mailingListSender')" min-width="180" show-overflow-tooltip/>
          <el-table-column :label="$t('mailingListOutcomes')" min-width="150">
            <template #default="{row}">{{ summary(row.totals) }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-if="reports.length === 0" :image-size="64" :description="$t('mailingListNoReports')"/>
      </section>
    </section>

    <el-dialog v-model="showCreate" :title="$t('mailingListAdd')" width="min(560px, calc(100% - 24px))">
      <el-form label-position="top" @submit.prevent="createList">
        <el-form-item :label="$t('mailingListAddress')">
          <el-input v-model="createForm.address" type="email" autocomplete="off"/>
        </el-form-item>
        <el-form-item :label="$t('mailingListDisplayName')">
          <el-input v-model="createForm.displayName"/>
        </el-form-item>
        <el-form-item :label="$t('mailingListMemberLimit')">
          <el-input-number v-model="createForm.memberLimit" :min="1" controls-position="right"/>
        </el-form-item>
        <el-form-item :label="$t('mailingListDailyLimit')">
          <el-input-number v-model="createForm.dailyPostLimit" :min="1" controls-position="right"/>
        </el-form-item>
        <div class="dialog-actions">
          <el-button @click="showCreate = false">{{ $t('cancel') }}</el-button>
          <el-button native-type="submit" type="primary" :loading="creating">{{ $t('mailingListAdd') }}</el-button>
        </div>
      </el-form>
    </el-dialog>

    <el-dialog v-model="showReport" :title="$t('mailingListReport')" width="min(680px, calc(100% - 24px))">
      <div v-if="activeReport" class="report-head">
        <div><span>{{ $t('mailingListSender') }}</span>{{ activeReport.sender }}</div>
        <div><span>{{ $t('mailingListAcceptedAt') }}</span>{{ activeReport.acceptedAt }}</div>
      </div>
      <el-table v-if="activeReport" :data="activeReport.outcomes" size="small">
        <el-table-column prop="deliveryId" :label="$t('mailingListDeliveryId')" width="110"/>
        <el-table-column prop="state" :label="$t('mailingListOutcome')" min-width="130">
          <template #default="{row}"><el-tag :type="deliveryType(row.state)">{{ deliveryLabel(row.state) }}</el-tag></template>
        </el-table-column>
        <el-table-column prop="safeReason" :label="$t('mailingListReason')" min-width="160" show-overflow-tooltip/>
      </el-table>
      <div class="dialog-actions">
        <el-button type="primary" :disabled="!activeReport?.totals?.failed" :loading="retrying" @click="retryFailed">{{ $t('mailingListRetry') }}</el-button>
      </div>
    </el-dialog>
  </main>
</template>

<script setup>
import {onMounted, reactive, ref} from 'vue';
import {Icon} from '@iconify/vue';
import {ElMessage, ElMessageBox} from 'element-plus';
import {useI18n} from 'vue-i18n';
import {
  mailingListAddMember,
  mailingListAddSender,
  mailingListCreate,
  mailingListDeleteMember,
  mailingListDeleteSender,
  mailingListDetail,
  mailingListList,
  mailingListMembers,
  mailingListReports,
  mailingListRetry,
  mailingListSenders,
  mailingListSetState,
  mailingListUpdate,
} from '@/request/mailing-list.js';

const {t} = useI18n();
const loading = ref(false);
const saving = ref(false);
const creating = ref(false);
const retrying = ref(false);
const search = ref('');
const lists = ref([]);
const selected = ref(null);
const members = ref([]);
const senders = ref([]);
const reports = ref([]);
const memberEmail = ref('');
const senderEmail = ref('');
const showCreate = ref(false);
const showReport = ref(false);
const activeReport = ref(null);
const createForm = reactive({address: '', displayName: '', memberLimit: null, dailyPostLimit: null});
const editor = reactive({displayName: '', postingPolicy: 'members', replyPolicy: 'sender', selfDelivery: true, memberLimit: null, dailyPostLimit: null});

onMounted(loadLists);

async function loadLists() {
  loading.value = true;
  try {
    lists.value = await mailingListList({search: search.value});
  } catch (error) {
    notifyError(error);
  } finally {
    loading.value = false;
  }
}

async function selectList(row) {
  try {
    selected.value = await mailingListDetail(row.list_id);
    Object.assign(editor, {
      displayName: selected.value.display_name,
      postingPolicy: selected.value.posting_policy,
      replyPolicy: selected.value.reply_policy,
      selfDelivery: Boolean(selected.value.self_delivery),
      memberLimit: selected.value.member_limit,
      dailyPostLimit: selected.value.daily_post_limit,
    });
    await loadDetails();
  } catch (error) {
    notifyError(error);
  }
}

async function loadDetails() {
  if (!selected.value) return;
  const listId = selected.value.list_id;
  [members.value, senders.value, reports.value] = await Promise.all([
    mailingListMembers(listId),
    mailingListSenders(listId),
    mailingListReports(listId),
  ]);
}

function openCreate() {
  Object.assign(createForm, {address: '', displayName: '', memberLimit: null, dailyPostLimit: null});
  showCreate.value = true;
}

async function createList() {
  creating.value = true;
  try {
    const list = await mailingListCreate({...createForm});
    showCreate.value = false;
    await loadLists();
    await selectList(list);
    ElMessage.success(t('mailingListCreated'));
  } catch (error) {
    notifyError(error);
  } finally {
    creating.value = false;
  }
}

async function saveEditor() {
  if (!selected.value) return;
  saving.value = true;
  try {
    selected.value = await mailingListUpdate({listId: selected.value.list_id, ...editor});
    await loadLists();
    ElMessage.success(t('mailingListSaved'));
  } catch (error) {
    notifyError(error);
  } finally {
    saving.value = false;
  }
}

async function changeState(state) {
  if (!selected.value) return;
  try {
    if (state === 'retired') await ElMessageBox.confirm(t('mailingListRetireConfirm'), t('mailingLists'), {type: 'warning'});
    selected.value = await mailingListSetState(selected.value.list_id, state);
    await loadLists();
  } catch (error) {
    selected.value = await mailingListDetail(selected.value.list_id);
    if (error !== 'cancel' && error !== 'close') notifyError(error);
  }
}

async function addMember() {
  if (!selected.value || !memberEmail.value) return;
  try {
    members.value = await mailingListAddMember(selected.value.list_id, memberEmail.value);
    memberEmail.value = '';
  } catch (error) {
    notifyError(error);
  }
}

async function removeMember(row) {
  try {
    await mailingListDeleteMember(selected.value.list_id, row.member_id);
    members.value = await mailingListMembers(selected.value.list_id);
  } catch (error) {
    notifyError(error);
  }
}

async function addSender() {
  if (!selected.value || !senderEmail.value) return;
  try {
    senders.value = await mailingListAddSender(selected.value.list_id, senderEmail.value);
    senderEmail.value = '';
  } catch (error) {
    notifyError(error);
  }
}

async function removeSender(row) {
  try {
    await mailingListDeleteSender(selected.value.list_id, row.sender_id);
    senders.value = await mailingListSenders(selected.value.list_id);
  } catch (error) {
    notifyError(error);
  }
}

function openReport(report) {
  activeReport.value = report;
  showReport.value = true;
}

async function retryFailed() {
  if (!selected.value || !activeReport.value) return;
  retrying.value = true;
  try {
    const result = await mailingListRetry(selected.value.list_id, activeReport.value.postId);
    ElMessage.success(t('mailingListRetryQueued', {count: result.requeued}));
    reports.value = await mailingListReports(selected.value.list_id);
    activeReport.value = reports.value.find(report => report.postId === activeReport.value.postId) || null;
  } catch (error) {
    notifyError(error);
  } finally {
    retrying.value = false;
  }
}

function stateLabel(state) {
  return t('mailingList' + state[0].toUpperCase() + state.slice(1));
}

function stateType(state) {
  return state === 'enabled' ? 'success' : state === 'retired' ? 'danger' : 'warning';
}

function deliveryLabel(state) {
  const labels = {
    delivered: 'delivered',
    failed: 'mailingListFailed',
    queued: 'mailingListQueued',
    processing: 'mailingListProcessing',
    skipped: 'mailingListSkipped',
  };
  return t(labels[state] || state);
}

function deliveryType(state) {
  return state === 'delivered' ? 'success' : state === 'failed' ? 'danger' : state === 'skipped' ? 'info' : 'warning';
}

function summary(totals) {
  return [
    t('delivered') + ': ' + totals.delivered,
    t('mailingListFailed') + ': ' + totals.failed,
    t('mailingListQueued') + ': ' + totals.queued,
    t('mailingListProcessing') + ': ' + totals.processing,
    t('mailingListSkipped') + ': ' + totals.skipped,
  ].join(' | ');
}

function notifyError(error) {
  ElMessage.error(error?.response?.data?.msg || error?.message || String(error));
}
</script>

<style scoped lang="scss">
.mailing-list {
  min-height: 100%;
  padding: 18px;
  overflow: auto;
}

.toolbar,
.inspector__head,
.add-line,
.dialog-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toolbar {
  margin-bottom: 14px;
}

.toolbar__search {
  width: min(360px, 100%);
  margin-right: auto;
}

.list-region {
  overflow-x: auto;

  :deep(.el-table) {
    min-width: 680px;
  }
}

.inspector {
  margin-top: 22px;
  border-top: 1px solid var(--el-border-color-light);
  padding-top: 18px;
}

.inspector__head {
  justify-content: space-between;
  margin-bottom: 16px;

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: 18px;
  }

  p {
    color: var(--el-text-color-secondary);
    margin-top: 4px;
  }
}

.state-select {
  width: 150px;
}

.policy-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(160px, 1fr));
  gap: 0 14px;
}

.toggle-field {
  align-self: end;
}

.inspector__actions {
  display: flex;
  justify-content: flex-end;
  margin: 2px 0 22px;
}

.operations-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px;
}

.operation,
.reports {
  border-top: 1px solid var(--el-border-color-light);
  padding-top: 14px;
}

.reports {
  margin-top: 22px;
}

h3 {
  font-size: 15px;
  margin: 0 0 12px;
}

.add-line {
  margin-bottom: 10px;
}

.report-head {
  display: grid;
  gap: 6px;
  margin-bottom: 14px;

  span {
    display: inline-block;
    color: var(--el-text-color-secondary);
    margin-right: 10px;
    min-width: 100px;
  }
}

.dialog-actions {
  justify-content: flex-end;
  margin-top: 18px;
}

@media (max-width: 767px) {
  .mailing-list {
    padding: 12px;
  }

  .list-region {
    :deep(.el-table) {
      min-width: 580px;
    }
  }

  .policy-grid,
  .operations-grid {
    grid-template-columns: 1fr;
  }

  .inspector__head {
    align-items: flex-start;
    flex-direction: column;
  }

  .add-line {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
