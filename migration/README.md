# Microsoft 365 migration

Read-only tools for exporting Cloud Mail data before migration to Exchange Online.

Safety rules:
- no D1 update/delete
- no R2 write/delete
- no DNS or MX changes
- use email_id as the full/delta watermark
- validate exports before import

Mailbox address mapping is in mailbox-map.json. Address matching is case-insensitive.

Folder mapping:
- type 0 -> Inbox
- type 1 -> Sent
- is_del 1 -> Deleted (when included)

Historical receive timestamp note: the current inbound path parses MIME but does not persist the original RFC Date header. The exporter therefore records create_time as cloudmail_create_time and marks the timestamp source in the manifest.

Pilot mailbox: jianfeng.jin@edmf.nl. Start with representative messages and validate Unicode, HTML/plain text, Message-ID/thread headers, attachments, inline CID images and timestamps before bulk migration.
