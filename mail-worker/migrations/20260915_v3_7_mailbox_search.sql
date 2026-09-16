-- Migration: v3_7 source-first mailbox search index
-- Tokenizer: FTS5 unicode61, contentful, no prefix index.
--
-- This is the schema-first operational form of dbInit.v3_7DB. The Worker
-- upgrade checks PRAGMA table_info(email) before adding search_dirty, so the
-- application upgrade is safe to rerun. When applying this file manually,
-- omit the ALTER TABLE statement if search_dirty is already present.
-- Keep search unavailable until every assertion below succeeds.

ALTER TABLE email ADD COLUMN search_dirty INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS email_search_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL CHECK (state IN ('NOT_READY', 'BUILDING', 'READY')),
    schema_fingerprint TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    verified_time DATETIME,
    update_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO email_search_meta (id, state, schema_fingerprint)
VALUES (1, 'NOT_READY', 'mailbox-search-v1:unicode61:no-prefix:contentful');

CREATE TABLE IF NOT EXISTS email_search_rate_guard (
    user_id INTEGER NOT NULL,
    scope TEXT NOT NULL,
    window_started INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_email_search_dirty_user
    ON email(user_id, search_dirty, email_id);
CREATE INDEX IF NOT EXISTS idx_email_search_rate_expiry
    ON email_search_rate_guard(expires_at);

CREATE TRIGGER IF NOT EXISTS email_search_dirty_after_update
AFTER UPDATE OF send_email, name, to_email, to_name, recipient, cc, bcc, subject, text, content ON email
WHEN (
    OLD.send_email IS NOT NEW.send_email OR OLD.name IS NOT NEW.name OR
    OLD.to_email IS NOT NEW.to_email OR OLD.to_name IS NOT NEW.to_name OR
    OLD.recipient IS NOT NEW.recipient OR OLD.cc IS NOT NEW.cc OR
    OLD.bcc IS NOT NEW.bcc OR OLD.subject IS NOT NEW.subject OR
    OLD.text IS NOT NEW.text OR OLD.content IS NOT NEW.content
) AND NEW.search_dirty != 1
BEGIN
    UPDATE email SET search_dirty = 1 WHERE email_id = NEW.email_id;
END;

UPDATE email_search_meta
SET state = 'BUILDING',
    generation = generation + 1,
    schema_fingerprint = 'mailbox-search-v1:unicode61:no-prefix:contentful',
    last_error = '',
    update_time = CURRENT_TIMESTAMP
WHERE id = 1;

-- Target-runtime tokenizer gate. These assertions deliberately fail the
-- migration before READY if unicode61/no-prefix semantics change.
DROP TABLE IF EXISTS email_search_token_probe;
CREATE VIRTUAL TABLE email_search_token_probe USING fts5(value, tokenize='unicode61');
INSERT INTO email_search_token_probe(rowid, value) VALUES
    (1, 'Café alphabet Привет'),
    (2, '项目更新 alice@example.com alpha-beta quote"mark wild*card');

DROP TABLE IF EXISTS email_search_migration_assert;
CREATE TABLE email_search_migration_assert (
    value INTEGER NOT NULL CHECK (value = 0)
);
INSERT INTO email_search_migration_assert
SELECT abs((SELECT count(*) FROM email_search_token_probe WHERE email_search_token_probe MATCH '"CAFÉ"') - 1);
INSERT INTO email_search_migration_assert
SELECT (SELECT count(*) FROM email_search_token_probe WHERE email_search_token_probe MATCH '"alph"');
INSERT INTO email_search_migration_assert
SELECT abs((SELECT count(*) FROM email_search_token_probe WHERE email_search_token_probe MATCH '"ПРИВЕТ"') - 1);
INSERT INTO email_search_migration_assert
SELECT abs((SELECT count(*) FROM email_search_token_probe WHERE email_search_token_probe MATCH '"项目更新"') - 1);
INSERT INTO email_search_migration_assert
SELECT (SELECT count(*) FROM email_search_token_probe WHERE email_search_token_probe MATCH '"项目"');
INSERT INTO email_search_migration_assert
SELECT abs((SELECT count(*) FROM email_search_token_probe WHERE email_search_token_probe MATCH '"alice" AND "example" AND "com"') - 1);
INSERT INTO email_search_migration_assert
SELECT abs((SELECT count(*) FROM email_search_token_probe WHERE email_search_token_probe MATCH '"alpha" AND "beta"') - 1);
INSERT INTO email_search_migration_assert
SELECT abs((SELECT count(*) FROM email_search_token_probe WHERE email_search_token_probe MATCH '"quote" AND "mark"') - 1);
INSERT INTO email_search_migration_assert
SELECT abs((SELECT count(*) FROM email_search_token_probe WHERE email_search_token_probe MATCH '"wild" AND "card"') - 1);
DROP TABLE email_search_token_probe;

-- One-shot source rebuild. email remains authoritative; attachments and
-- attachment objects are intentionally absent from this statement.
DROP TABLE IF EXISTS email_search_fts;
CREATE VIRTUAL TABLE email_search_fts USING fts5(
    email_id UNINDEXED,
    sender,
    recipients,
    subject,
    body_text,
    body_html,
    tokenize='unicode61'
);

INSERT INTO email_search_fts
    (rowid, email_id, sender, recipients, subject, body_text, body_html)
SELECT email_id,
       email_id,
       coalesce(send_email, '') || ' ' || coalesce(name, ''),
       coalesce(to_email, '') || ' ' || coalesce(to_name, '') || ' ' ||
           coalesce(recipient, '') || ' ' || coalesce(cc, '') || ' ' || coalesce(bcc, ''),
       coalesce(subject, ''),
       coalesce(text, ''),
       CASE WHEN trim(coalesce(text, '')) = '' THEN coalesce(content, '') ELSE '' END
FROM email;

UPDATE email SET search_dirty = 0;
INSERT INTO email_search_fts(email_search_fts) VALUES('integrity-check');

-- Completeness, orphan, and dirty-row gates. CHECK failure leaves the
-- generation BUILDING so dbInit.v3_7DB or scheduled maintenance can rebuild.
DELETE FROM email_search_migration_assert;
INSERT INTO email_search_migration_assert
SELECT count(*)
FROM email e
LEFT JOIN email_search_fts f ON f.rowid = e.email_id
WHERE f.rowid IS NULL;
INSERT INTO email_search_migration_assert
SELECT count(*)
FROM email_search_fts f
LEFT JOIN email e ON e.email_id = f.rowid
WHERE e.email_id IS NULL;
INSERT INTO email_search_migration_assert
SELECT count(*) FROM email WHERE search_dirty = 1;
INSERT INTO email_search_migration_assert
SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM email e
    WHERE trim(coalesce(e.send_email, '')) != ''
      AND NOT EXISTS (
          SELECT 1
          FROM email_search_fts f
          WHERE f.rowid = e.email_id
            AND email_search_fts MATCH ('"' || replace(e.send_email, '"', '""') || '"')
      )
    LIMIT 1
) THEN 1 ELSE 0 END;
DROP TABLE email_search_migration_assert;

UPDATE email_search_meta
SET state = 'READY',
    schema_fingerprint = 'mailbox-search-v1:unicode61:no-prefix:contentful',
    last_error = '',
    verified_time = CURRENT_TIMESTAMP,
    update_time = CURRENT_TIMESTAMP
WHERE id = 1;
