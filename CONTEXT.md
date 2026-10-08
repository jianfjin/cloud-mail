# CONTEXT — cloud-mail

Glossary of canonical terms for the cloud-mail codebase. Keep this file a
glossary only: no implementation details, no specs, no scratch notes.

## Terms

- **Admin account** — the single user whose email address is the one
  configured as the deployment's admin value. Admin status is derived from
  that configured address, not from any flag or role stored in the database.
  All other users are regular users.

- **Manage tools** — the group of administrative menu items in the web
  client sidebar: Analytics, All Users, All Mail, Roles, Invite Codes, and
  System Settings. Each tool is visible only to users holding the
  corresponding query permission; the Admin account is treated as holding
  every permission.

- **Role** — a named group of users sharing the same set of permissions and
  send limits. Every user belongs to exactly one role; a default role exists
  for newly registered users.

- **Permission** — a single grantable capability (for example: view all
  users, delete any email, manage system settings). Permissions are attached
  to roles; users acquire them through their role.

- **Managed email domain** — a DNS domain whose addresses this deployment
  accepts for mailboxes (login, registration, inbound mail). More than one
  may be managed at a time; a cutover window is such a case. Addresses
  outside the managed domains are not valid identities here.

- **Mailbox rename (in place)** — changing an existing mailbox's address from
  one managed email domain to another while preserving the user row, history,
  messages, and attachments. Distinct from migration (moving data between
  systems) and from deletion.
