---
date: 2026-06-01
topic: account-signatures
---

# Account Signatures Requirements

## Summary

Cloud Mail will support per-email-account rich-text signatures. Users can edit a signature for each sender address, and the app auto-inserts it into new messages, replies, and forwards while leaving the inserted content editable before send.

---

## Problem Frame

Cloud Mail users can manage multiple sender addresses from one account. A single user-level signature would blur identities when different addresses represent different roles, domains, or contact details. The missing capability is a sender-specific signature that travels with the selected email account and saves users from manually retyping title, address, contact links, or other footer details.

---

## Key Decisions

- **Per-account signatures:** Signature ownership follows the sender address, not the user or the site. This keeps identities separate when one user sends from multiple addresses.
- **Rich text editing:** Signatures should allow formatted title, address, links, and contact blocks rather than forcing a fixed structured template.
- **Auto insertion:** Signatures appear by default in compose flows so users do not need to remember a manual insert action.
- **Editable after insertion:** The inserted signature is normal compose content. Users can adjust or remove it before sending.

---

## Requirements

**Signature Management**

- R1. Each email account can have zero or one rich-text signature.
- R2. Users can create, edit, clear, and save the signature for an email account they own.
- R3. Signature editing is reachable from the existing account-management surface where users already rename, pin, and delete sender addresses.
- R4. Empty signatures are allowed and mean no signature is inserted for that account.

**Compose Behavior**

- R5. Starting a new message from an account with a signature inserts that signature into the compose editor automatically.
- R6. Replies and forwards insert the signature above the quoted or forwarded content.
- R7. Changing the sender account before sending updates the compose signature to match the selected account when the existing inserted signature has not been materially edited.
- R8. Once the user edits or removes the inserted signature in a draft, the app must not unexpectedly overwrite their draft content.

**User Experience**

- R9. The signature editor should feel consistent with the existing rich-text compose editor.
- R10. Saving a signature should give clear success or failure feedback.
- R11. Signatures should work for normal users and admins according to the same account ownership rules that already govern sending.

---

## Actors

- A1. **Mailbox user:** Owns one or more email accounts and configures signatures for those sender addresses.
- A2. **Admin user:** Has broad permissions but still benefits from per-address signatures.
- A3. **Recipient:** Receives email with the sender's chosen signature as part of the message body.

---

## Key Flows

- F1. Configure a signature
  - **Trigger:** A user opens an email account's settings menu.
  - **Actors:** A1 or A2
  - **Steps:** User chooses signature settings, edits rich-text content, saves, and sees confirmation.
  - **Outcome:** Future messages from that account can include the saved signature.
  - **Covered by:** R1, R2, R3, R9, R10

- F2. Compose a new message
  - **Trigger:** A user opens the compose editor.
  - **Actors:** A1 or A2
  - **Steps:** App selects the current sender account, detects its saved signature, and inserts it into the editable body.
  - **Outcome:** The message starts with the sender's signature ready to keep, edit, or remove.
  - **Covered by:** R4, R5, R8, R11

- F3. Reply or forward
  - **Trigger:** A user replies to or forwards an existing email.
  - **Actors:** A1 or A2
  - **Steps:** App prepares editable reply content, inserts the sender signature, and places quoted or forwarded content below it.
  - **Outcome:** The user's signature stays with their new response, not buried after quoted content.
  - **Covered by:** R6, R8, R11

- F4. Change sender while composing
  - **Trigger:** A user changes the selected sender account in the compose editor.
  - **Actors:** A1 or A2
  - **Steps:** App considers whether the auto-inserted signature is still untouched. If untouched, it swaps to the new account's signature; if edited, it preserves the draft.
  - **Outcome:** Sender changes do not silently corrupt user-authored content.
  - **Covered by:** R7, R8

---

## Acceptance Examples

- AE1. Covers R5 and R8.
  - **Given:** `support@example.com` has a saved signature.
  - **When:** The user opens a new compose window from that account.
  - **Then:** The signature appears in the rich-text body and can be edited before sending.

- AE2. Covers R6.
  - **Given:** The selected account has a saved signature and the user replies to an email.
  - **When:** The reply editor opens.
  - **Then:** The signature appears above the quoted original message.

- AE3. Covers R7 and R8.
  - **Given:** The app auto-inserted Account A's signature and the user has not edited it.
  - **When:** The user changes the sender to Account B.
  - **Then:** Account A's signature is replaced with Account B's signature.

- AE4. Covers R7 and R8.
  - **Given:** The user has edited the inserted signature or surrounding draft content.
  - **When:** The user changes the sender account.
  - **Then:** The app preserves the draft instead of overwriting content unexpectedly.

---

## Scope Boundaries

- Global admin-enforced signatures are out of scope for v1.
- Multiple signature templates per account are out of scope for v1.
- Signature analytics, legal disclaimer enforcement, and organization-wide branding rules are out of scope.
- A manual "insert signature" command is deferred unless testing shows auto-insertion creates too much friction.

---

## Success Criteria

- Users can configure distinct signatures for distinct sender addresses.
- New messages, replies, and forwards include the expected signature without extra user action.
- Signature insertion never unexpectedly destroys user-authored draft content.
- The feature fits the existing account and compose workflows without introducing a separate settings area users have to discover from scratch.

---

## Dependencies / Assumptions

- The app continues to treat email accounts as the sender identity users choose from when composing.
- The existing rich-text compose experience is sufficient as the model for signature editing.
- Account ownership remains the boundary for who can edit a signature.

---

## Sources / Research

- `mail-vue/src/layout/account/index.vue` currently contains the account menu for rename, pin, and delete actions.
- `mail-vue/src/layout/write/index.vue` currently owns compose, reply, forward, sender selection, and rich-text body handling.
- `mail-worker/src/entity/account.js` currently models per-email-account sender identity.
- `mail-worker/src/service/email-service.js` currently sends the compose HTML content without a signature-specific layer.
