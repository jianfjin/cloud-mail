# D1 migrations

## v3.7 mailbox search rollout

Mailbox search is a derived, source-first subsystem. The `email` table is the
source of truth; `email_search_fts` can always be discarded and rebuilt. The
index contains stored sender/name, recipient headers, subject, plain text, and
HTML fallback only. It never reads attachment rows or attachment objects.

### Readiness states

- `NOT_READY`: no search request may query FTS. The next initialization or
  scheduled maintenance run recreates the generation from `email`.
- `BUILDING`: a rebuild started but has not passed tokenizer, schema,
  integrity, completeness, orphan, dirty-row, and MATCH probes. Search remains
  unavailable.
- `READY`: the global schema/generation passed verification. A user is still
  searchable only after that user's `search_dirty` count reaches zero.

New email rows receive `search_dirty = 1` from the ordinary column default.
Updates to stored searchable fields set it through a source-table trigger in
the same D1 statement. No receive, send, status, logical-delete, restore, or
physical-delete write calls FTS before the source mutation succeeds.

### Schema-first deployment

1. Rehearse `20260915_v3_7_mailbox_search.sql` against a production-shaped
   D1 copy and record duration, rows read/written, and database growth. Stop if
   the one-shot rebuild lacks comfortable D1 execution headroom.
2. Back up D1. Apply the migration before deploying search endpoints. When
   `email.search_dirty` already exists, omit the migration's `ALTER TABLE`;
   the Worker `v3_7DB` upgrade performs this check automatically and is the
   preferred rerunnable entrypoint.
3. Confirm `email_search_meta.state = 'READY'`, the fingerprint is
   `mailbox-search-v1:unicode61:no-prefix:contentful`, the FTS integrity
   command succeeds, there are no orphan/missing documents, and no source row
   remains dirty from the rebuild.
4. Deploy the Worker. Authenticated requests may reconcile at most 25 rows for
   their user; the scheduled Worker reconciles at most 250 rows per run. A user
   with remaining dirty rows receives controlled unavailability, never partial
   results.

The checked-in SQL is an operational schema/rebuild artifact. Its column-add
statement is intentionally one-shot because SQLite has no `ADD COLUMN IF NOT
EXISTS`; all other recovery should use the runtime `v3_7DB` path, which checks
the column and validates a healthy generation without rebuilding it.

### Failure and recovery

Do not mark a failed generation ready by hand. Leave it `NOT_READY` or
`BUILDING` and rerun `v3_7DB`. The rebuild drops only the derived FTS table,
repopulates it from `email`, clears dirty markers in the same D1 batch as the
population, verifies it, and only then marks it `READY`.

Reconciliation is idempotent: delete/insert replacement by `email_id` and the
conditional dirty-marker clear share one successful D1 batch. If a batch
fails, affected rows remain dirty. Physical-delete cleanup is best effort;
search always joins FTS candidates back to live relational rows, and scheduled
maintenance removes orphan documents.

### Normal rollback

1. Set the singleton state to `NOT_READY` before removing or disabling search
   endpoints.
2. Roll back the Worker. Leave the additive column, metadata, trigger, and
   rate-guard table in place; older mailbox flows do not depend on the derived
   index and this preserves a simple forward recovery.
3. The virtual table may be dropped after search traffic is disabled. Do not
   rebuild or rewrite authoritative email rows as part of rollback.

### Quiesced export/import

1. Set search `NOT_READY` and stop all email mutations.
2. Drop `email_search_fts`; it is derived and should not be treated as export
   authority.
3. Export or import the relational D1 database.
4. Ensure the v3.7 supporting schema exists, then run
   `UPDATE email SET search_dirty = 1`.
5. Run the rerunnable `v3_7DB` rebuild and all readiness checks. Confirm the
   generation is `READY` and dirty count is zero.
6. Resume email mutations, then enable search traffic.

If target D1 cannot create FTS5 with the recorded `unicode61` semantics, or the
one-shot rebuild cannot fit safely, stop the rollout instead of substituting a
table scan or exposing a partial generation.
