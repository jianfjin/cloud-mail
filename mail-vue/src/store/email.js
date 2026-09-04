import { defineStore } from 'pinia'
import { EmailUnreadEnum } from '@/enums/email-enum.js'
import { emailCalendarPreview } from '@/request/email.js'

const calendarPreviewRequests = new Map()

export const useEmailStore = defineStore('email', {
    state: () => ({
        deleteIds: 0,
        starScroll: null,
        emailScroll: null,
        cancelStarEmailId: 0,
        addStarEmailId: 0,
        contentData: {
            email: null,
            delType: null,
            showStar: true,
            showReply: true,
            showUnread: false
        },
        sendScroll: null,
        detailMap: {},
        calendarPreviewMap: {},
    }),
    persist: {
        pick: ['contentData'],
    },
    actions: {
        fetchList(request) {
            request(1).then(data => {
                const list = Array.isArray(data) ? data : data?.list
                this.applyFullList(list)
            }).catch(e => {
                console.error(e)
            })
            return request(0)
        },
        applyFullList(list) {
            if (!list?.length) return
            const currentId = this.contentData.email?.emailId
            for (const item of list) {
                if (!item?.emailId) continue
                if (!item.attList) item.attList = []
                // 完整列表可能早于「标已读」返回，避免把本地已读状态盖回未读
                const prev = this.detailMap[item.emailId]
                const keepRead = prev?.unread === EmailUnreadEnum.READ
                    || (currentId === item.emailId && this.contentData.email?.unread === EmailUnreadEnum.READ)
                if (keepRead) {
                    item.unread = EmailUnreadEnum.READ
                }
                this.detailMap[item.emailId] = item
                if (currentId && item.emailId === currentId) {
                    this.contentData.email = item
                }
            }
        },
        toContentEmail(email) {
            const id = email?.emailId
            if (id && this.detailMap[id]) {
                return this.detailMap[id]
            }
            return {
                ...email,
                emailId: id || 0,
                content: '',
                text: '',
                attList: [],
                recipient: email?.recipient || '[]',
                cc: email?.cc || '[]',
                bcc: email?.bcc || '[]',
            }
        },
        markListRead(emailId) {
            const scrolls = [this.emailScroll, this.starScroll, this.sendScroll]
            for (const scroll of scrolls) {
                const list = scroll?.emailList
                if (!list?.length) continue
                const item = list.find(e => e.emailId === emailId)
                if (item) item.unread = EmailUnreadEnum.READ
            }
        },
        fetchCalendarPreview(email) {
            const emailId = Number(email?.emailId)
            if (!emailId) return Promise.resolve(null)
            const existing = this.calendarPreviewMap[emailId]
            if (existing?.status === 'success' || existing?.status === 'terminal') {
                return Promise.resolve(existing.envelope)
            }
            if (calendarPreviewRequests.has(emailId)) return calendarPreviewRequests.get(emailId)

            this.calendarPreviewMap[emailId] = {status: 'loading', envelope: existing?.envelope || null}
            const request = emailCalendarPreview(emailId).then(envelope => {
                this.calendarPreviewMap[emailId] = {status: 'success', envelope}
                return envelope
            }).catch(error => {
                const status = error?.response?.status
                this.calendarPreviewMap[emailId] = {
                    status: status === undefined || status === 429 || status >= 500 ? 'retryable' : 'terminal',
                    envelope: null,
                }
                return null
            }).finally(() => {
                calendarPreviewRequests.delete(emailId)
            })
            calendarPreviewRequests.set(emailId, request)
            return request
        },
    },
})
