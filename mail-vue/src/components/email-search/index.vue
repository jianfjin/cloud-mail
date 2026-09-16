<template>
  <div class="email-search" role="search" @keydown.esc.prevent="cancel">
    <div class="email-search__bar">
      <button class="email-search__mobile-back" type="button" :aria-label="$t('closeSearch')" @click="cancel">
        <Icon icon="ep:arrow-left" />
      </button>
      <input
        ref="quickInput"
        v-model="quickQuery"
        data-testid="email-search-quick"
        class="email-search__input"
        type="search"
        :placeholder="$t('searchMail')"
        :aria-label="$t('searchMail')"
        @keyup.enter="submitQuick"
      >
      <button
        ref="advancedTrigger"
        data-testid="email-search-advanced"
        class="email-search__advanced-trigger"
        type="button"
        :aria-expanded="String(expanded)"
        aria-controls="email-search-advanced-panel"
        :aria-label="$t('advancedSearch')"
        @click="openAdvanced"
      >
        <Icon icon="ep:arrow-down" />
      </button>
      <button class="email-search__submit" type="button" :aria-label="$t('searchMail')" @click="submitQuick">
        <Icon icon="ep:search" />
      </button>
    </div>

    <section
      id="email-search-advanced-panel"
      data-testid="email-search-panel"
      class="email-search__panel"
      :aria-hidden="String(!expanded)"
      :hidden="!expanded"
    >
      <button class="email-search__panel-close" type="button" :aria-label="$t('closeSearch')" @click="cancel">
        <Icon icon="ep:close" />
      </button>
      <div class="email-search__fields">
        <label v-for="field in textFields" :key="field.key">
          <span>{{ $t(field.label) }}</span>
          <input v-model="draft[field.key]" type="text">
        </label>
        <label>
          <span>{{ $t('searchSize') }}</span>
          <div class="email-search__inline">
            <select v-model="draft.size.comparator"><option value="gt">{{ $t('greaterThan') }}</option><option value="lt">{{ $t('lessThan') }}</option></select>
            <input v-model="draft.size.amount" type="number" min="1" max="999999" inputmode="numeric">
            <select v-model="draft.size.unit"><option>KB</option><option>MB</option><option>GB</option></select>
          </div>
        </label>
        <label>
          <span><input data-testid="email-search-date-enabled" v-model="dateEnabled" type="checkbox"> {{ $t('dateWithin') }}</span>
          <div class="email-search__inline">
            <input data-testid="email-search-date-amount" v-model="draft.date.amount" :disabled="!dateEnabled" type="number" min="1" :max="dateLimit" inputmode="numeric">
            <select v-model="draft.date.unit" :disabled="!dateEnabled"><option value="day">{{ $t('day') }}</option><option value="week">{{ $t('week') }}</option><option value="month">{{ $t('month') }}</option><option value="year">{{ $t('year') }}</option></select>
          </div>
        </label>
        <label>
          <span>{{ $t('searchLocation') }}</span>
          <select data-testid="email-search-location" v-model="draft.location"><option value="all">{{ $t('allMail') }}</option><option value="inbox">{{ $t('inbox') }}</option><option value="sent">{{ $t('sent') }}</option><option value="starred">{{ $t('starred') }}</option></select>
        </label>
        <label class="email-search__checkbox"><input v-model="draft.hasAttachment" type="checkbox"><span>{{ $t('hasAttachment') }}</span></label>
      </div>
      <p v-if="error" class="email-search__error" role="alert">{{ error }}</p>
      <div class="email-search__actions">
        <button type="button" @click="reset">{{ $t('reset') }}</button>
        <button type="button" @click="cancel">{{ $t('cancel') }}</button>
        <button data-testid="email-search-submit" type="button" class="email-search__primary" @click="submitAdvanced">{{ $t('search') }}</button>
      </div>
    </section>
  </div>
</template>

<script setup>
import {computed, nextTick, ref} from 'vue'
import {Icon} from '@iconify/vue'
import {emptySearchDraft, normalizeSearchCriteria} from '@/utils/email-search.js'

const emit = defineEmits(['search'])
const quickInput = ref(null)
const advancedTrigger = ref(null)
const expanded = ref(false)
const quickQuery = ref('')
const draft = ref(emptySearchDraft())
const dateEnabled = ref(true)
const error = ref('')
const textFields = [
  {key: 'from', label: 'from'}, {key: 'to', label: 'recipient'}, {key: 'subject', label: 'subject'},
  {key: 'hasWords', label: 'hasWords'}, {key: 'doesntHave', label: 'doesntHave'},
]
const dateLimit = computed(() => ({day: 365, week: 52, month: 120, year: 10}[draft.value.date.unit]))

function cloneDraft() { return JSON.parse(JSON.stringify(draft.value)) }
function openAdvanced() {
  expanded.value = !expanded.value
  error.value = ''
  if (expanded.value) nextTick(() => document.querySelector('#email-search-advanced-panel input')?.focus())
}
function close() {
  expanded.value = false
  error.value = ''
  nextTick(() => advancedTrigger.value?.focus())
}
function cancel() { close() }
function reset() { draft.value = emptySearchDraft(); dateEnabled.value = true; error.value = '' }
function submitQuick() {
  const query = quickQuery.value.trim()
  if (query) emit('search', {query})
}
function submitAdvanced() {
  try {
    const nextDraft = cloneDraft()
    if (!dateEnabled.value) nextDraft.date.amount = ''
    const criteria = normalizeSearchCriteria(nextDraft)
    emit('search', criteria)
    close()
  } catch (reason) {
    error.value = reason.message
  }
}
</script>

<style lang="scss" scoped>
.email-search { position: relative; min-width: 260px; max-width: 640px; width: 100%; }
.email-search__bar { display: flex; align-items: center; min-height: 36px; border: 1px solid var(--dark-border); border-radius: 8px; background: var(--el-bg-color); }
.email-search__input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--el-text-color-primary); padding: 8px 10px; }
.email-search button { border: 0; background: transparent; color: var(--el-text-color-primary); cursor: pointer; min-width: 34px; min-height: 34px; border-radius: 5px; }
.email-search button:focus-visible, .email-search input:focus-visible, .email-search select:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
.email-search button:hover { background: var(--base-fill); }
.email-search__mobile-back { display: none; }
.email-search__panel { position: absolute; z-index: 40; top: calc(100% + 6px); left: 0; width: min(620px, calc(100vw - 24px)); padding: 16px; border: 1px solid var(--dark-border); border-radius: 8px; background: var(--el-bg-color); box-shadow: var(--el-box-shadow-light); text-align: left; }
.email-search__panel-close { position: absolute; top: 6px; right: 6px; }
.email-search__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.email-search__fields label { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 8px; align-items: center; font-size: 13px; }
.email-search__fields input, .email-search__fields select { min-width: 0; min-height: 30px; border: 1px solid var(--dark-border); border-radius: 4px; padding: 4px 6px; color: var(--el-text-color-primary); background: var(--el-bg-color); }
.email-search__inline { display: flex; gap: 6px; min-width: 0; }.email-search__inline input { width: 72px; }.email-search__inline select { flex: 1; }
.email-search__fields .email-search__checkbox { grid-template-columns: auto 1fr; justify-content: start; }.email-search__checkbox input { min-height: auto; }
.email-search__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }.email-search .email-search__primary { color: white; background: var(--el-color-primary); padding: 0 14px; }
.email-search__error { color: var(--el-color-danger); font-size: 12px; margin: 10px 0 0; }
@media (max-width: 767px) { .email-search { min-width: 0; }.email-search__mobile-back { display: inline-flex; align-items: center; justify-content: center; }.email-search__fields { grid-template-columns: 1fr; }.email-search__panel { position: fixed; top: 0; bottom: 0; left: 0; width: 100vw; overflow-y: auto; border-radius: 0; padding: 52px 20px 20px; }.email-search__fields label { grid-template-columns: 92px minmax(0, 1fr); } }
</style>
