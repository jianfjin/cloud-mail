# Keep the foreign queue consumer satisfied with a no-op handler

The production `cloud-mail` Worker was running a build (v38, deployed 2026-09-06) that does **not exist in this repo**: it exports a `processMailingListQueue` handler and its deployment registered the Worker as a consumer of queue `cloud-mail-mailing-list`. Cloudflare rejects any new `cloud-mail` version that lacks a `queue` export while that consumer registration exists (API error 11001, "Queue handler is missing"), so this repo could not deploy at all.

We decided to satisfy the registration instead of removing it: `src/index.js` exports a no-op `queue` handler that logs and acks each message. The consumer registration itself stays on the Cloudflare queue side; this repo declares no queue bindings in `wrangler.production.toml`. Alternatives: deleting the consumer in the Cloudflare dashboard (manual step, and it would recur whenever the foreign build is redeployed), or tracking down the foreign build first — its origin is still unknown.

**Consequences:** any message that arrives on `cloud-mail-mailing-list` is logged and dropped by this build. If the mailing-list feature is ever merged into this repo, replace the no-op handler with the real one and supersede this ADR.
