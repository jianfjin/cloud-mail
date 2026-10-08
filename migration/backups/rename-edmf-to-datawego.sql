BEGIN;
UPDATE user SET email = REPLACE(email, '@edmf.nl', '@datawego.nl') WHERE lower(email) LIKE '%@edmf.nl';
UPDATE account SET email = REPLACE(email, '@edmf.nl', '@datawego.nl') WHERE lower(email) LIKE '%@edmf.nl';
UPDATE email SET send_email = REPLACE(send_email, '@edmf.nl', '@datawego.nl') WHERE send_email LIKE '%@edmf.nl%';
UPDATE email SET to_email = REPLACE(to_email, '@edmf.nl', '@datawego.nl') WHERE to_email LIKE '%@edmf.nl%';
UPDATE mailing_list_member SET email = REPLACE(email, '@edmf.nl', '@datawego.nl') WHERE email LIKE '%@edmf.nl%';
UPDATE setting SET resend_tokens = '{"datawego.nl":"<RESEND_API_KEY — from setting.resend_tokens in D1 or admin UI>"}';
COMMIT;
