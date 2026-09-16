<template>
  <section class="search-results" aria-live="polite">
    <header class="search-results__header">
      <div>
        <h1>{{ $t('searchMail') }}</h1>
        <p v-if="total !== null" data-testid="search-total">{{ total }} {{ total === 1 ? $t('searchResult') : $t('searchResults') }}</p>
      </div>
      <label>
        <span class="sr-only">{{ $t('searchMail') }}</span>
        <select v-model="order" data-testid="search-order">
          <option value="newest">{{ $t('searchNewest') }}</option>
          <option value="oldest">{{ $t('searchOldest') }}</option>
        </select>
      </label>
    </header>

    <div v-if="missing" class="search-results__message" role="alert">
      <p>{{ $t('searchExpired') }}</p>
    </div>
    <div v-else-if="error" class="search-results__message" role="alert">
      <p>{{ error }}</p>
      <button type="button" @click="retry">{{ $t('searchRetry') }}</button>
    </div>
    <div v-else-if="loading && !emails.length" class="search-results__message">{{ $t('searchLoading') }}</div>
    <div v-else-if="!emails.length" class="search-results__message">{{ $t('noMessagesFound') }}</div>

    <ol v-else class="search-results__list">
      <li v-for="email in emails" :key="email.emailId" class="search-results__row">
        <button
          class="search-results__item"
          type="button"
          :data-testid="`search-result-${email.emailId}`"
          @click="openEmail(email)"
        >
          <span class="search-results__party">{{ Number(email.type) === 1 ? $t('searchTo') : $t('searchFrom') }}: {{ party(email) }}</span>
          <span class="search-results__subject">{{ email.subject || $t('noSubject') }}</span>
          <span class="search-results__preview">{{ email.text || '' }}</span>
        </button>
        <div class="search-results__actions">
          <button type="button" :aria-label="$t('star')" @click="toggleStar(email)">{{ email.isStar ? '★' : '☆' }}</button>
          <button type="button" :aria-label="$t('delete')" @click="deleteResult(email)">×</button>
        </div>
      </li>
    </ol>
    <div v-if="hydrating" class="search-results__hydrating">{{ $t('searchLoading') }}</div>
    <button v-if="nextCursor && !loading && !error" class="search-results__more" type="button" @click="loadMore">
      {{ $t('loadMore') }}
    </button>
  </section>
</template>

<script setup>
import {onActivated, ref, watch} from 'vue'
import {useRoute, useRouter} from 'vue-router'
import {useI18n} from 'vue-i18n'
import {emailDelete, emailSearch, emailSearchDetails} from '@/request/email.js'
import {readSearchCriteria} from '@/utils/email-search.js'
import {useEmailStore} from '@/store/email.js'
import {starAdd, starCancel} from '@/request/star.js'

defineOptions({name: 'search'})

const PAGE_SIZE = 50
const route = useRoute()
const router = useRouter()
const emailStore = useEmailStore()
const {t} = useI18n()
const criteria = ref(null)
const emails = ref([])
const total = ref(null)
const nextCursor = ref(null)
const order = ref('newest')
const loading = ref(false)
const hydrating = ref(false)
const missing = ref(false)
const error = ref('')
let requestGeneration = 0

function token() {
  return typeof route.query.search === 'string' ? route.query.search : ''
}

function party(email) {
  return Number(email.type) === 1 ? (email.toEmail || email.name || '') : (email.name || email.sendEmail || '')
}

function errorText(reason) {
  const response = reason?.response
  const status = response?.status || reason?.status || reason?.code
  if (status === 429) {
    const raw = response?.headers?.['retry-after'] ?? response?.headers?.get?.('retry-after') ?? 0
    const seconds = Math.max(1, Number.parseInt(raw, 10) || 1)
    return t('searchRateLimited', {seconds})
  }
  if (status === 503) return t('searchUnavailable')
  return reason?.message || t('searchUnavailable')
}

async function hydrate(list, generation) {
  const ids = list.map(item => item.emailId).filter(Number.isSafeInteger).slice(0, PAGE_SIZE)
  if (!ids.length) return
  hydrating.value = true
  try {
    const data = await emailSearchDetails({generation, emailIds: ids})
    if (generation !== requestGeneration || data?.generation !== generation) return
    emailStore.applyFullList(data?.list || [])
  } catch (reason) {
    // Brief, owned rows remain safe and usable if a detail batch must be retried.
    console.warn('Search result hydration failed', reason)
  } finally {
    if (generation === requestGeneration) hydrating.value = false
  }
}

async function search({cursor = null, replace = false} = {}) {
  if (!criteria.value) return
  const generation = ++requestGeneration
  loading.value = true
  error.value = ''
  if (replace) {
    emails.value = []
    total.value = null
    nextCursor.value = null
  }
  try {
    const data = await emailSearch({
      generation,
      criteria: criteria.value,
      order: order.value,
      pageSize: PAGE_SIZE,
      ...(cursor ? {cursor} : {}),
    })
    if (generation !== requestGeneration || data?.generation !== generation) return
    const list = Array.isArray(data?.list) ? data.list : []
    let append = list
    if (!replace) {
      const seen = new Set(emails.value.map(item => item.emailId))
      append = list.filter(item => !seen.has(item.emailId))
    }
    emails.value = replace ? append : [...emails.value, ...append]
    nextCursor.value = data?.nextCursor || null
    if (replace) total.value = Number.isFinite(data?.total) ? data.total : 0
    await hydrate(append, generation)
  } catch (reason) {
    if (generation === requestGeneration) error.value = errorText(reason)
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

function initialize() {
  const saved = readSearchCriteria(token())
  requestGeneration += 1
  criteria.value = saved
  missing.value = !saved
  error.value = ''
  emails.value = []
  total.value = null
  nextCursor.value = null
  if (saved) search({replace: true})
}

function retry() { search({replace: true}) }
function loadMore() { if (nextCursor.value) search({cursor: nextCursor.value}) }
function openEmail(email) {
  emailStore.contentData.email = emailStore.toContentEmail(email)
  emailStore.contentData.delType = 'logic'
  emailStore.contentData.showUnread = Number(email.type) === 0
  emailStore.contentData.showStar = true
  emailStore.contentData.showReply = true
  emailStore.contentData.returnRoute = {name: 'search', query: {search: token()}}
  router.push({name: 'content'})
}

async function toggleStar(email) {
  const previous = Boolean(email.isStar)
  email.isStar = previous ? 0 : 1
  try {
    if (previous) await starCancel(email.emailId)
    else await starAdd(email.emailId)
  } catch (reason) {
    email.isStar = previous ? 1 : 0
    console.warn('Search result star update failed', reason)
  }
}

async function deleteResult(email) {
  try {
    await emailDelete([email.emailId])
    emails.value = emails.value.filter(item => item.emailId !== email.emailId)
    if (total.value !== null) total.value = Math.max(0, total.value - 1)
  } catch (reason) {
    console.warn('Search result delete failed', reason)
  }
}

watch(() => route.query.search, initialize, {immediate: true})
watch(order, () => { if (criteria.value) search({replace: true}) })
onActivated(() => {
  // A kept-alive result never falls back to Inbox. Re-read only if its opaque token changed.
  if (!criteria.value || token() !== route.query.search) initialize()
})
</script>

<style scoped lang="scss">
.search-results { height: 100%; overflow: auto; background: var(--el-bg-color); }
.search-results__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 18px; box-shadow: var(--header-actions-border); }
.search-results__header h1 { margin: 0; font-size: 17px; }.search-results__header p { margin: 3px 0 0; color: var(--el-text-color-secondary); font-size: 13px; }
.search-results__header select, .search-results__more, .search-results__message button { min-height: 32px; border: 1px solid var(--dark-border); border-radius: 5px; padding: 4px 9px; color: var(--el-text-color-primary); background: var(--el-bg-color); }
.search-results__list { margin: 0; padding: 0; list-style: none; }.search-results__row { display: flex; border-bottom: 1px solid var(--dark-border); }
.search-results__item { display: grid; flex: 1; grid-template-columns: minmax(150px, 24%) minmax(160px, 34%) 1fr; width: 100%; gap: 10px; border: 0; padding: 13px 18px; color: var(--el-text-color-primary); background: transparent; text-align: left; cursor: pointer; }
.search-results__item:hover, .search-results__item:focus-visible { background: var(--base-fill); outline: 2px solid var(--el-color-primary); outline-offset: -2px; }.search-results__party { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.search-results__subject { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.search-results__preview { overflow: hidden; color: var(--el-text-color-secondary); text-overflow: ellipsis; white-space: nowrap; }
.search-results__actions { display: flex; align-items: center; gap: 4px; padding: 0 10px; }.search-results__actions button { min-width: 28px; min-height: 28px; border: 0; border-radius: 4px; color: var(--el-text-color-primary); background: transparent; cursor: pointer; font-size: 20px; }.search-results__actions button:hover, .search-results__actions button:focus-visible { background: var(--base-fill); outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.search-results__message { padding: 36px 18px; text-align: center; color: var(--el-text-color-secondary); }.search-results__hydrating { padding: 8px 18px; color: var(--el-text-color-secondary); font-size: 13px; }.search-results__more { display: block; margin: 14px auto; cursor: pointer; }.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
@media (max-width: 767px) { .search-results__item { grid-template-columns: 1fr; gap: 3px; padding: 12px 15px; }.search-results__preview { display: none; } }
</style>
