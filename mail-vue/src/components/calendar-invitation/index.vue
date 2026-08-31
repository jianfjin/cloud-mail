<template>
  <section class="calendar-preview" :aria-labelledby="titleId" data-testid="calendar-preview">
    <header class="calendar-preview__header">
      <div>
        <p class="calendar-preview__eyebrow">{{ t('calendarInvitation') }}</p>
        <h2 :id="titleId">{{ heading }}</h2>
      </div>
      <span v-if="validEnvelope" class="calendar-preview__state">{{ t(`calendarState_${validEnvelope.state}`) }}</span>
    </header>

    <div class="calendar-preview__notice" aria-live="polite" aria-atomic="true">
      <p v-if="requestState === 'loading'">{{ t('calendarLoading') }}</p>
      <p v-else-if="requestState === 'retryable'">
        {{ t('calendarTemporarilyUnavailable') }}
        <button type="button" class="calendar-preview__retry" @click="$emit('retry')">{{ t('calendarRetry') }}</button>
      </p>
      <p v-else-if="requestState === 'terminal'">{{ t('calendarUnavailable') }}</p>
      <p v-else-if="!validEnvelope">{{ t('calendarUnsupportedVersion') }}</p>
      <p v-else-if="validEnvelope.state === 'partial'">{{ t('calendarPartialWarning') }}</p>
      <p v-else-if="validEnvelope.state === 'unsupported'">{{ t('calendarUnsupported') }}</p>
      <p v-else-if="validEnvelope.state === 'failed'">{{ t('calendarFailed') }}</p>
    </div>

    <ol v-if="events.length" class="calendar-preview__events">
      <li v-for="event in events" :key="event.key" class="calendar-event">
        <div class="calendar-event__topline">
          <p class="calendar-event__action">{{ t(event.actionKey) }} · {{ t('calendarSenderDeclared') }}</p>
          <p v-if="event.status" class="calendar-event__sender-status">
            {{ t('calendarSenderStatus', {status: event.status}) }}
          </p>
        </div>
        <h3>{{ event.summary || t('calendarUntitledEvent') }}</h3>

        <p class="calendar-event__time">
          <span class="calendar-event__label">{{ t('calendarWhen') }}</span>
          <span>{{ event.time.text }}</span>
          <span v-if="event.time.qualifier" class="calendar-event__qualifier">{{ event.time.qualifier }}</span>
        </p>
        <p v-if="event.location" class="calendar-event__row">
          <span class="calendar-event__label">{{ t('calendarWhere') }}</span>
          <span>{{ event.location }}</span>
        </p>
        <p v-if="event.organizer" class="calendar-event__row">
          <span class="calendar-event__label">{{ t('calendarOrganizer') }}</span>
          <span>{{ personLabel(event.organizer) }}</span>
        </p>

        <a
          v-if="event.meetingLink?.direct"
          class="calendar-event__join"
          :href="event.meetingLink.url"
          target="_blank"
          rel="noopener noreferrer"
          referrerpolicy="no-referrer"
        >{{ t('calendarJoinMeeting', {host: event.meetingLink.hostname}) }}</a>
        <button
          v-else-if="event.meetingLink"
          type="button"
          class="calendar-event__join calendar-event__join--unverified"
          @click="confirmUnverified(event.meetingLink)"
        >{{ t('calendarReviewMeetingLink', {host: event.meetingLink.hostname}) }}</button>

        <details v-if="event.description || event.attendees.length || event.omittedAttendeeCount" class="calendar-event__details">
          <summary>{{ t('calendarMoreDetails') }}</summary>
          <div v-if="event.description" class="calendar-event__description">
            <h4>{{ t('calendarDescription') }}</h4>
            <p>{{ event.description }}</p>
          </div>
          <div v-if="event.attendees.length || event.omittedAttendeeCount" class="calendar-event__attendees">
            <h4>{{ t('calendarAttendees') }}</h4>
            <ul>
              <li v-for="(attendee, index) in event.attendees" :key="`${event.key}:attendee:${index}`">
                {{ personLabel(attendee) }}
                <span v-if="attendee.participationStatus"> · {{ attendee.participationStatus }}</span>
              </li>
            </ul>
            <p v-if="event.omittedAttendeeCount">{{ t('calendarAttendeesOmitted', {count: event.omittedAttendeeCount}) }}</p>
          </div>
        </details>
      </li>
    </ol>
    <p v-else-if="validEnvelope && requestState === 'success'" class="calendar-preview__empty">
      {{ t('calendarNoRenderableEvents') }}
    </p>
  </section>
</template>

<script setup>
import {computed} from 'vue'
import {ElMessageBox} from 'element-plus'
import {useI18n} from 'vue-i18n'
import {formatCalendarPoint} from '@/utils/day.js'

const props = defineProps({
  envelope: {type: Object, default: null},
  requestState: {type: String, default: 'success'},
})

defineEmits(['retry'])

const {t, locale} = useI18n()
const titleId = `calendar-preview-${Math.random().toString(36).slice(2)}`
const envelopeStates = new Set(['parsed', 'partial', 'unsupported', 'failed'])
const trustedProviders = new Map([
  ['meet.google.com', 'google-meet'],
  ['teams.microsoft.com', 'microsoft-teams'],
  ['teams.live.com', 'microsoft-teams'],
])

function boundedString(value, maximum = 32768) {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

function validPerson(value) {
  if (!value || typeof value !== 'object') return null
  const name = boundedString(value.name, 512)
  const address = boundedString(value.address, 512)
  return name || address ? {name, address} : null
}

function meetingLink(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') return null
  if (value.url.length > 2048 || /[\u0000-\u001f\u007f]/.test(value.url)) return null
  try {
    const parsed = new URL(value.url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) return null
    const hostname = parsed.hostname.toLowerCase()
    const direct = value.trust === 'trusted' && trustedProviders.get(hostname) === value.provider
    return {url: parsed.href, hostname, direct}
  } catch (_) {
    return null
  }
}

function normalizedEvent(value, index) {
  if (!value || typeof value !== 'object') return null
  const attendees = Array.isArray(value.attendees)
    ? value.attendees.slice(0, 200).map(validPerson).filter(Boolean)
    : []
  for (let attendeeIndex = 0; attendeeIndex < attendees.length; attendeeIndex += 1) {
    attendees[attendeeIndex].participationStatus = boundedString(value.attendees[attendeeIndex]?.participationStatus, 64)
  }
  const recurrenceId = boundedString(value.recurrenceId, 512)
  const action = ['invitation', 'update', 'cancellation', 'calendar'].includes(value.action) ? value.action : 'calendar'
  return {
    key: `${boundedString(value.uid, 512) || 'event'}:${recurrenceId}:${Number(value.sequence) || 0}:${index}`,
    actionKey: action === 'cancellation' && recurrenceId
      ? 'calendarAction_instanceCancellation'
      : `calendarAction_${action}`,
    status: boundedString(value.status, 64),
    summary: boundedString(value.summary, 2048),
    description: boundedString(value.description),
    location: boundedString(value.location, 4096),
    organizer: validPerson(value.organizer),
    attendees,
    omittedAttendeeCount: Number.isSafeInteger(value.omittedAttendeeCount) && value.omittedAttendeeCount > 0
      ? value.omittedAttendeeCount
      : 0,
    start: value.start,
    end: value.end,
    meetingLink: meetingLink(value.meetingLink),
  }
}

const validEnvelope = computed(() => {
  const value = props.envelope
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.parserVersion !== 'ical.js/2.2.1'
    || !envelopeStates.has(value.state)
    || !Array.isArray(value.events)) return null
  return value
})

function pointQualifier(point) {
  if (!point) return ''
  if (point.kind === 'all-day') return t('calendarAllDay')
  if (point.kind === 'floating') return t('calendarFloatingTime')
  if (point.kind === 'unresolved') return t('calendarUnresolvedZone', {zone: point.sourceTimeZone || t('unknown')})
  if (point.viewerTimeZone) {
    return point.sourceTimeZone && point.sourceTimeZone !== point.viewerTimeZone
      ? t('calendarViewerAndSourceZone', {viewerZone: point.viewerTimeZone, sourceZone: point.sourceTimeZone})
      : t('calendarViewerZone', {zone: point.viewerTimeZone})
  }
  return ''
}

function eventTime(event) {
  const start = formatCalendarPoint(event.start, locale.value)
  const end = formatCalendarPoint(event.end, locale.value)
  if (!start) return {text: t('calendarTimeUnavailable'), qualifier: ''}
  return {
    text: end ? `${start.text} – ${end.text}` : start.text,
    qualifier: pointQualifier(start),
  }
}

const events = computed(() => (validEnvelope.value?.events || [])
  .slice(0, 32)
  .map(normalizedEvent)
  .filter(Boolean)
  .map(event => ({...event, time: eventTime(event)})))

const heading = computed(() => events.value.length === 1
  ? events.value[0].summary || t('calendarUntitledEvent')
  : t('calendarEvents', {count: events.value.length}))

function personLabel(person) {
  if (person.name && person.address) return `${person.name} <${person.address}>`
  return person.name || person.address
}

async function confirmUnverified(link) {
  try {
    await ElMessageBox.confirm(t('calendarUnverifiedConfirm', {host: link.hostname}), {
      confirmButtonText: t('calendarOpenLink'),
      cancelButtonText: t('cancel'),
      type: 'warning',
    })
    window.open(link.url, '_blank', 'noopener,noreferrer')
  } catch (_) {
    // Cancellation is expected and leaves the user on the message.
  }
}
</script>

<style scoped lang="scss">
.calendar-preview {
  width: min(760px, 100%);
  margin-bottom: 20px;
  border: 1px solid var(--light-border-color);
  border-radius: 10px;
  background: var(--extra-light-fill);
  overflow-wrap: anywhere;
}

.calendar-preview__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--light-border-color);

  h2 { font-size: 18px; line-height: 1.35; }
}

.calendar-preview__eyebrow {
  margin-bottom: 3px;
  color: var(--secondary-text-color);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .04em;
  text-transform: uppercase;
}

.calendar-preview__state,
.calendar-event__action {
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 600;
}

.calendar-preview__state { flex: 0 0 auto; }

.calendar-preview__notice:not(:empty),
.calendar-preview__empty {
  padding: 12px 20px;
  color: var(--regular-text-color);
}

.calendar-preview__retry,
.calendar-event__join {
  min-height: 36px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
}

.calendar-preview__retry {
  margin-left: 8px;
  color: var(--el-color-primary);
  text-decoration: underline;
}

.calendar-preview__events { padding: 0 20px; }
.calendar-event { padding: 18px 0 20px; }
.calendar-event + .calendar-event { border-top: 1px solid var(--light-border-color); }
.calendar-event h3 { margin: 5px 0 14px; font-size: 17px; }
.calendar-event__topline { display: flex; justify-content: space-between; gap: 12px; }
.calendar-event__sender-status { color: var(--secondary-text-color); font-size: 12px; }
.calendar-event__time,
.calendar-event__row { display: grid; grid-template-columns: 85px minmax(0, 1fr); gap: 4px 12px; margin: 8px 0; }
.calendar-event__qualifier { grid-column: 2; color: var(--secondary-text-color); font-size: 12px; }
.calendar-event__label { color: var(--secondary-text-color); font-weight: 600; }

.calendar-event__join {
  display: inline-flex;
  align-items: center;
  margin-top: 10px;
  padding: 0 14px;
  background: var(--el-color-primary);
  color: #fff;
  text-decoration: none;
}

.calendar-event__join--unverified {
  border: 1px solid var(--el-color-warning);
  background: transparent;
  color: var(--el-color-warning);
}

.calendar-preview button:focus-visible,
.calendar-preview a:focus-visible,
.calendar-preview summary:focus-visible {
  outline: 3px solid var(--el-color-primary-light-5);
  outline-offset: 3px;
}

.calendar-event__details { margin-top: 16px; }
.calendar-event__details summary { width: fit-content; cursor: pointer; color: var(--el-color-primary); }
.calendar-event__details h4 { margin: 12px 0 4px; font-size: 14px; }
.calendar-event__description p { white-space: pre-wrap; }
.calendar-event__attendees ul { list-style: disc; padding-left: 20px; }

@media (max-width: 600px) {
  .calendar-preview__header,
  .calendar-event__topline { flex-direction: column; }
  .calendar-preview__header,
  .calendar-preview__events { padding-left: 14px; padding-right: 14px; }
  .calendar-event__time,
  .calendar-event__row { grid-template-columns: 1fr; }
  .calendar-event__qualifier { grid-column: 1; }
  .calendar-event__join { width: 100%; justify-content: center; text-align: center; }
}
</style>
