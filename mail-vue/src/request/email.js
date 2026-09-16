import http from '@/axios/index.js';

export function emailList(accountId, allReceive, emailId, timeSort, size, type, full) {
    return http.get('/email/list', {params: {accountId, allReceive, emailId, timeSort, size, type, full}})
}

export function emailDelete(emailIds) {
    return http.delete('/email/delete?emailIds=' + emailIds)
}

export function emailLatest(emailId, accountId, allReceive) {
    return http.get('/email/latest', {params: {emailId, accountId, allReceive}, noMsg: true, timeout: 35 * 1000})
}

export function emailRead(emailIds) {
    return http.put('/email/read', {emailIds})
}

// Search deliberately uses POST: criteria must never be copied into a URL.
export function emailSearch(params) {
    return http.post('/email/search', params, {noMsg: true})
}

export function emailSearchDetails(params) {
    return http.post('/email/search/details', params, {noMsg: true})
}

export function emailCalendarPreview(emailId) {
    return http.post('/email/calendar-preview', {emailId}, {noMsg: true})
}

export function emailCalendarEligibility(params) {
    return http.post('/email/calendar-response/eligibility', params, {noMsg: true})
}

export function emailCalendarResponse(params) {
    return http.post('/email/calendar-response', params, {noMsg: true})
}

export function emailCalendarResponseRetry(params) {
    return http.post('/email/calendar-response/retry', params, {noMsg: true})
}

export function emailSend(form,progress) {
    return http.post('/email/send', form,{
        onUploadProgress: (e) => {
            progress(e)
        },
        noMsg: true
    })
}
