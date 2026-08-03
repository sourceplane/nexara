# Open Risks

Live risks for nexara. Add entries as they surface; close them
with a note when mitigated.

## Active Risks

- Production OAuth/magic-link auth and Stripe need human-supplied
  credentials before those surfaces work end-to-end
  (`orun secrets set ... --env <env>`; wire-now-seed-later).
- Notifications email needs one-time Cloudflare Email Service setup
  (Workers Paid plan + sending-domain DKIM/SPF).
