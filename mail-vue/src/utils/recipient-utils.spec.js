import { describe, expect, it } from 'vitest'
import { deriveReplyAllRecipients, normalizeRecipientGroups } from './recipient-utils.js'

describe('normalizeRecipientGroups', () => {
  it('allows a CC-only or BCC-only send and deduplicates within each role', () => {
    expect(normalizeRecipientGroups({
      receiveEmail: [],
      cc: ['CC@example.net', 'cc@example.net'],
      bcc: ['blind@example.net'],
    })).toMatchObject({
      to: [],
      cc: ['CC@example.net'],
      bcc: ['blind@example.net'],
      all: ['CC@example.net', 'blind@example.net'],
      errors: [],
    })
  })

  it('blocks duplicates across roles without collapsing distinct plus addresses', () => {
    const result = normalizeRecipientGroups({
      receiveEmail: ['same@example.net', 'same+tag@example.net'],
      cc: ['SAME@example.net'],
      bcc: [],
    })

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({type: 'duplicate', role: 'to'}),
      expect.objectContaining({type: 'duplicate', role: 'cc'}),
    ]))
    expect(result.to).toEqual(['same@example.net', 'same+tag@example.net'])
  })
})

describe('deriveReplyAllRecipients', () => {
  const ownedEmails = ['owner@example.com', 'alias@example.com']

  it('puts a received message sender in To and eligible visible peers in Cc', () => {
    const recipients = deriveReplyAllRecipients({
      type: 0,
      sendEmail: 'organizer@example.net',
      recipient: JSON.stringify([
        { address: 'owner@example.com', name: 'Owner' },
        { address: 'peer@example.net', name: 'Peer' },
      ]),
      cc: JSON.stringify([
        { address: 'ALIAS@example.com', name: 'Alias' },
        { address: 'cc@example.net', name: 'Cc' },
      ]),
      bcc: JSON.stringify([{ address: 'blind@example.net', name: 'Blind' }]),
    }, ownedEmails)

    expect(recipients).toEqual({
      to: ['organizer@example.net'],
      cc: ['peer@example.net', 'cc@example.net'],
      bcc: [],
    })
  })

  it('preserves visible roles for the sender sent copy and never uses BCC', () => {
    const recipients = deriveReplyAllRecipients({
      type: 1,
      sendEmail: 'owner@example.com',
      recipient: JSON.stringify([
        { address: 'to@example.net', name: 'To' },
        { address: 'OWNER+calendar@example.com', name: 'Owner' },
      ]),
      cc: JSON.stringify([
        { address: 'cc@example.net', name: 'Cc' },
        { address: 'TO@example.net', name: 'Duplicate' },
      ]),
      bcc: JSON.stringify([{ address: 'blind@example.net', name: 'Blind' }]),
    }, ownedEmails)

    expect(recipients).toEqual({
      to: ['to@example.net'],
      cc: ['cc@example.net'],
      bcc: [],
    })
  })

  it('returns null when no eligible visible recipient remains or historical JSON is invalid', () => {
    expect(deriveReplyAllRecipients({
      type: 0,
      sendEmail: 'owner@example.com',
      recipient: 'not-json',
      cc: '[]',
    }, ownedEmails)).toBeNull()
  })
})
