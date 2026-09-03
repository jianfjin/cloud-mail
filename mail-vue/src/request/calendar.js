import http from '@/axios/index.js';

export function getCalendarProviders() {
    return http.get('/calendar/providers')
}

export function addCalendarProvider(provider) {
    return http.post('/calendar/providers', provider)
}

export function updateCalendarProvider(providerId, provider) {
    return http.put('/calendar/providers/' + providerId, provider)
}
