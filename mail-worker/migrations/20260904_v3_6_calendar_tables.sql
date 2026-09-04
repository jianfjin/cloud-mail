-- Migration: v3_6 calendar tables (manual backfill)
-- Applied: 2026-09-04 to production D1 "cloud-mail-db"
--          (database_id: 37af850a-d300-4a8a-a71a-4864a7e5cdf6)
-- Why: the worker code shipped 2026-09-03 (commit b011b71) began querying
--      calendar_provider / calendar_response, but /init/:secret was never
--      re-run on production, so the v3_6DB tables were missing and every
--      /email/calendar-preview request failed with "no such table".
-- How: applied via `wrangler d1 execute cloud-mail-db --remote` from
--      mail-worker/ on 2026-09-04; all statements are idempotent
--      (IF NOT EXISTS / INSERT OR IGNORE) and match v3_6DB in
--      src/init/init.js verbatim. Re-running is safe.
-- Note: the rest of v3_6DB-era schema (email.calendar_data,
--       attachments.calendar_method, calendar_repair_guard) already
--       existed in production from the v3_5 migration.

CREATE TABLE IF NOT EXISTS calendar_response (
    response_id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_id INTEGER NOT NULL,
    event_uid TEXT NOT NULL,
    recurrence_id TEXT NOT NULL DEFAULT '',
    account_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    participation_status TEXT NOT NULL,
    organizer TEXT NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'dispatching',
    provider_receipt TEXT NOT NULL DEFAULT '',
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dispatched_time DATETIME,
    delivered_time DATETIME,
    UNIQUE (email_id, event_uid, recurrence_id, account_id, participation_status)
);

CREATE TABLE IF NOT EXISTS calendar_provider (
    provider_id INTEGER PRIMARY KEY AUTOINCREMENT,
    host TEXT NOT NULL,
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by_user_id INTEGER NOT NULL DEFAULT 0,
    updated_by_user_id INTEGER NOT NULL DEFAULT 0,
    create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_provider_host_nocase ON calendar_provider(host COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_calendar_response_email ON calendar_response(email_id);
CREATE INDEX IF NOT EXISTS idx_calendar_response_user_state ON calendar_response(user_id, delivery_state);

INSERT OR IGNORE INTO calendar_provider (host, label, enabled)
VALUES
    ('meet.google.com', 'Google Meet', 1),
    ('teams.microsoft.com', 'Microsoft Teams', 1),
    ('teams.live.com', 'Microsoft Teams', 1);
