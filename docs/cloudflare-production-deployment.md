# Cloudflare Production Deployment

This runbook applies to the production Cloudflare Worker named `cloud-mail`,
served at `https://mail.edmf.nl`.

Run all commands from `mail-worker` unless stated otherwise:

```bash
cd ~/projects/cloud-mail/mail-worker
```

## Production Secret

`jwt_secret` is an encrypted Cloudflare Worker secret. It is available to the
Worker as `env.jwt_secret` and is used to sign and verify login JWTs.

- It is bound to the production `cloud-mail` Worker as a `secret_text`
  binding.
- Cloudflare does not reveal a secret value after it has been uploaded.
- Do not put it in `wrangler.production.toml`, `.env`, shell history, or Git.
- Keep the value in a password manager only when initially creating or
  intentionally rotating it.

Secrets belong to the Cloudflare Worker, not to the machine that ran Wrangler.
Any authorized machine can deploy the same Worker without having the secret
value locally. A normal `wrangler deploy` preserves encrypted Worker secrets.

Check that the binding exists without exposing its value:

```bash
npx wrangler secret list --config wrangler.production.toml
```

Expected output includes:

```text
jwt_secret  secret_text
```

## First-Time Setup or Secret Rotation

Use this only when `jwt_secret` is missing or needs to be replaced. Rotating
the secret invalidates every existing browser session, so users must sign in
again.

1. Generate a value and save the displayed value in the password manager.

   ```bash
   openssl rand -hex 48
   ```

2. Upload that exact value interactively. Interactive entry avoids accidentally
   uploading an empty value through a broken shell pipeline.

   ```bash
   npx wrangler secret put jwt_secret --config wrangler.production.toml
   ```

3. Paste the generated value at Wrangler's prompt. The command publishes a new
   Worker version itself; a separate `wrangler deploy` is not needed just to
   apply the secret.

4. Verify the secret name appears in `wrangler secret list`, then sign in using
   a fresh browser session.

## Deployment Procedure

1. Authenticate Wrangler to the Cloudflare account that owns `cloud-mail`.
   A machine may use `wrangler login` or an appropriately scoped
   `CLOUDFLARE_API_TOKEN`.

2. Confirm the production secret is present:

   ```bash
   npx wrangler secret list --config wrangler.production.toml
   ```

3. Review the generated Worker and frontend build without publishing it:

   ```bash
   npx wrangler deploy --dry-run --config wrangler.production.toml
   ```

   The production config builds the Vue assets before packaging the Worker.

4. Deploy:

   ```bash
   npx wrangler deploy --config wrangler.production.toml
   ```

5. Reload `https://mail.edmf.nl` and test sign-in. For mail changes, also send
   a controlled message and confirm the expected mailbox record is created.

Before accepting any Wrangler configuration-difference prompt, verify that the
local production configuration declares the intended D1, KV, R2, AI, assets,
cron, variables, and custom-domain settings. Continuing replaces the remote
configuration with the local one.

## Empty HMAC Key Recovery

An error similar to the following means the active Worker received an empty
`jwt_secret`:

```text
Imported HMAC key length (0) must be a non-zero value
```

1. Run `wrangler secret list` using `wrangler.production.toml`.
2. If `jwt_secret` is absent, create it with the interactive rotation procedure
   above.
3. If the name is listed but the error remains, rotate it interactively. A
   secret name can exist while its value is empty.
4. Wait briefly for the newly published version, hard-refresh the site, and
   sign in again.
5. If the error persists, confirm in the Cloudflare dashboard that
   `mail.edmf.nl` is mapped to the `cloud-mail` production Worker, rather than
   another Worker or environment.

Never attempt to recover a previously uploaded secret from Cloudflare. It is
not retrievable; rotate it and save the new value instead.
