# EDMF → DataWeGo cutover — executed plan

**Status: executed 2026-10-08.** Decision record: `docs/adr/0002-in-place-rebrand-to-datawego.md`.

Goal: repurpose the single `cloud-mail` deployment (same Cloudflare account `52fdf946…`; Worker + D1 `cloud-mail-db` + R2 `cloud-mail-r2` + KV `00b08442…`, bindings unchanged) from EDMF to DataWeGo. No data migration, no R2 re-upload.

## What was done

1. **Config sync** — live Worker already had `domain=["datawego.nl"]`, `admin="admin@datawego.nl"`, and the `mail.datawego.nl` custom domain; `wrangler.production.toml`/`wrangler.toml` were synced to match (so a future `wrangler deploy` cannot revert them). Dev `jwt_secret` placeholder scrubbed; untracked `jwt_secret.txt` deleted.
2. **Backup** — direct `d1 export` is impossible (FTS5 virtual tables); rollback = `migration/backups/rollback-edmf-rename.sql` (row-level reverse mapping, 699 UPDATEs) + pre-snapshots `rb_{user,account,ml,email}.txt` + D1 Time Travel.
3. **Rename in place** — one atomic D1 batch: `user.email` (11), `account.email` (11), `email.send_email`, `email.to_email`, `mailing_list_member.email` (8), `setting.resend_tokens` → `{"datawego.nl": <same Resend key>}`. Case-variant local-parts (`ZhaoLu@`, `Lu.Zhao@`) preserved; bodies/Message-IDs untouched by decision. Verified: zero `@edmf.nl` in all identity columns; search index self-heals via triggers.
4. **Cache/session invalidation** — KV meta-keys purged (`setting:`, all `auth-uid:*`); `jwt_secret` rotated via API → every old session dead, including any cached `@edmf.nl` identities.
5. **Email Routing** — `datawego.nl` catch-all: forward→Gmail **changed to Worker `cloud-mail`** (inbound now lands in webmail). `edmf.nl` catch-all (was Worker): **disabled** — inbound EDMF bounces (hard cut).
6. **EDMF web off-board** — `mail.edmf.nl` custom domain deleted from the Worker (now answers 530); the Worker's only custom domain is `mail.datawego.nl`.

## Verified

- `https://mail.datawego.nl/` → 200 SPA.
- Login gate: `jianfeng.jin@edmf.nl` → "输入的邮箱不存在"; `jianfeng.jin@datawego.nl` → password check reached (domain accepted).

## Follow-ups (manual / external)

- [x] **Resend** — verified 2026-10-08: send + receive confirmed as `jianfeng.jin@datawego.nl` (same account API key reused for `datawego.nl`).
- [ ] Users must sign in again at `https://mail.datawego.nl` with their `@datawego.nl` address (same password). Announce once.
- [ ] Optional: delete the orphan `mail` DNS record in the `edmf.nl` zone (needs zone DNS access; token here lacked it) — already inert.
- [ ] Optional: leave a mailto/website pointer at EDMF from `edmf.nl` contacts to the new addresses.
