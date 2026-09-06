import http from '@/axios/index.js';

export function mailingListList(params) {
    return http.get('/mailingList/list', {params});
}

export function mailingListDetail(listId) {
    return http.get('/mailingList/detail', {params: {listId}});
}

export function mailingListCreate(form) {
    return http.post('/mailingList/create', form);
}

export function mailingListUpdate(form) {
    return http.put('/mailingList/update', form);
}

export function mailingListSetState(listId, state) {
    return http.put('/mailingList/state', {listId, state});
}

export function mailingListMembers(listId) {
    return http.get('/mailingList/members', {params: {listId}});
}

export function mailingListAddMember(listId, email) {
    return http.post('/mailingList/member', {listId, email});
}

export function mailingListDeleteMember(listId, memberId) {
    return http.delete('/mailingList/member', {params: {listId, memberId}});
}

export function mailingListSenders(listId) {
    return http.get('/mailingList/senders', {params: {listId}});
}

export function mailingListAddSender(listId, email) {
    return http.post('/mailingList/sender', {listId, email});
}

export function mailingListDeleteSender(listId, senderId) {
    return http.delete('/mailingList/sender', {params: {listId, senderId}});
}

export function mailingListReports(listId) {
    return http.get('/mailingList/reports', {params: {listId}});
}

export function mailingListReport(listId, postId) {
    return http.get('/mailingList/report', {params: {listId, postId}});
}

export function mailingListRetry(listId, postId) {
    return http.post('/mailingList/retry', {listId, postId});
}
