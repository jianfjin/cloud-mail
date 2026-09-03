<template>
  <section class="calendar-provider-settings" data-testid="calendar-provider-settings">
    <div class="calendar-provider-settings__heading">
      <div class="card-title">{{ t('calendarProviders') }}</div>
    </div>
    <form class="calendar-provider-settings__form" @submit.prevent="createProvider">
      <el-input
        v-model="form.host"
        :placeholder="t('calendarProviderHost')"
        :disabled="saving"
        autocomplete="off"
      />
      <el-input
        v-model="form.label"
        :placeholder="t('calendarProviderLabel')"
        :disabled="saving"
        autocomplete="off"
      />
      <el-button type="primary" native-type="submit" :loading="saving">
        {{ t('calendarProviderAdd') }}
      </el-button>
    </form>

    <p v-if="!providers.length && !loading" class="calendar-provider-settings__empty">
      {{ t('calendarProviderEmpty') }}
    </p>
    <div v-else class="calendar-provider-settings__list">
      <div v-for="provider in providers" :key="provider.providerId" class="calendar-provider-settings__row">
        <span class="calendar-provider-settings__name">{{ provider.label }}</span>
        <code>{{ provider.host }}</code>
        <el-switch
          :model-value="Boolean(provider.enabled)"
          :loading="changingId === provider.providerId"
          :aria-label="provider.label"
          @change="enabled => changeEnabled(provider, enabled)"
        />
      </div>
    </div>
  </section>
</template>

<script setup>
import {onMounted, reactive, ref} from 'vue'
import {useI18n} from 'vue-i18n'
import {addCalendarProvider, getCalendarProviders, updateCalendarProvider} from '@/request/calendar.js'

const {t} = useI18n()
const providers = ref([])
const loading = ref(false)
const saving = ref(false)
const changingId = ref(null)
const form = reactive({host: '', label: ''})

async function loadProviders() {
  loading.value = true
  try {
    const data = await getCalendarProviders()
    providers.value = Array.isArray(data) ? data : []
  } finally {
    loading.value = false
  }
}

async function createProvider() {
  if (!form.host.trim() || !form.label.trim() || saving.value) return
  saving.value = true
  try {
    const provider = await addCalendarProvider({
      host: form.host.trim(),
      label: form.label.trim(),
    })
    providers.value = [...providers.value, provider]
    form.host = ''
    form.label = ''
  } finally {
    saving.value = false
  }
}

async function changeEnabled(provider, enabled) {
  if (changingId.value || Boolean(provider.enabled) === Boolean(enabled)) return
  changingId.value = provider.providerId
  try {
    const updated = await updateCalendarProvider(provider.providerId, {enabled: Boolean(enabled)})
    providers.value = providers.value.map(item => item.providerId === updated.providerId ? updated : item)
  } finally {
    changingId.value = null
  }
}

onMounted(loadProviders)
</script>

<style scoped lang="scss">
.calendar-provider-settings { display: grid; gap: 14px; }
.calendar-provider-settings__form { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(140px, 1fr) auto; gap: 10px; }
.calendar-provider-settings__list { display: grid; border-top: 1px solid var(--light-border-color); }
.calendar-provider-settings__row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(160px, 1.5fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 42px;
  border-bottom: 1px solid var(--light-border-color);
}
.calendar-provider-settings__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.calendar-provider-settings__row code { color: var(--secondary-text-color); overflow-wrap: anywhere; }
.calendar-provider-settings__empty { color: var(--secondary-text-color); }

@media (max-width: 600px) {
  .calendar-provider-settings__form { grid-template-columns: 1fr; }
  .calendar-provider-settings__form .el-button { width: 100%; }
  .calendar-provider-settings__row { grid-template-columns: minmax(0, 1fr) auto; }
  .calendar-provider-settings__row code { grid-column: 1; }
  .calendar-provider-settings__row .el-switch { grid-column: 2; grid-row: 1 / span 2; }
}
</style>
