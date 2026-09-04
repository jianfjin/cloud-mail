import { isEmail } from './verify-utils.js'

const roleConfig = [
  { input: 'receiveEmail', output: 'to', label: 'to' },
  { input: 'cc', output: 'cc', label: 'cc' },
  { input: 'bcc', output: 'bcc', label: 'bcc' },
]

function addressValue(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value.address === 'string') return value.address.trim()
  return ''
}

function comparableAddress(value) {
  const address = addressValue(value).toLowerCase()
  const atIndex = address.lastIndexOf('@')
  if (atIndex <= 0) return address
  return `${address.slice(0, atIndex).split('+')[0]}@${address.slice(atIndex + 1)}`
}

function recipientKey(value) {
  return addressValue(value).toLowerCase()
}

function parseAddressList(value) {
  if (Array.isArray(value)) return value.map(addressValue).filter(Boolean)
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(addressValue).filter(Boolean) : []
  } catch {
    return []
  }
}

export function parseRecipientAddresses(value) {
  return parseAddressList(value)
}

function addEligible(target, values, owned, seen) {
  for (const value of values) {
    const address = addressValue(value)
    const comparable = comparableAddress(address)
    if (!address || !isEmail(address) || owned.has(comparable) || seen.has(comparable)) continue
    seen.add(comparable)
    target.push(address)
  }
}

export function normalizeRecipientGroups(input = {}) {
  const result = { to: [], cc: [], bcc: [] }
  const errors = []
  const seenAcrossRoles = new Map()

  for (const role of roleConfig) {
    const values = Array.isArray(input[role.input]) ? input[role.input] : []
    const seen = new Set()

    for (const value of values) {
      const address = addressValue(value)
      const key = recipientKey(address)
      if (!isEmail(address)) {
        errors.push({ role: role.output, address, type: 'invalid' })
        continue
      }
      if (seen.has(key)) continue
      seen.add(key)
      result[role.output].push(address)
      const roles = seenAcrossRoles.get(key) || []
      roles.push(role.output)
      seenAcrossRoles.set(key, roles)
    }
  }

  for (const [address, roles] of seenAcrossRoles) {
    if (roles.length > 1) {
      for (const role of roles) errors.push({ role, address, type: 'duplicate' })
    }
  }

  const all = [...result.to, ...result.cc, ...result.bcc]
  if (all.length === 0) errors.push({ type: 'empty' })
  return { ...result, all, errors }
}

export function deriveReplyAllRecipients(email, ownedEmails = []) {
  const owned = new Set(ownedEmails.map(comparableAddress).filter(Boolean))
  const to = []
  const cc = []
  const seen = new Set()
  const originalTo = parseAddressList(email?.recipient)
  const originalCc = parseAddressList(email?.cc)

  if (Number(email?.type) === 1) {
    addEligible(to, originalTo, owned, seen)
    addEligible(cc, originalCc, owned, seen)
  } else {
    addEligible(to, [email?.sendEmail], owned, seen)
    addEligible(cc, [...originalTo, ...originalCc], owned, seen)
  }

  if (to.length === 0 && cc.length === 0) return null
  return { to, cc, bcc: [] }
}
