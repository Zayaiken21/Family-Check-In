# Family Check-In

A mobile-first GitHub Pages app for consent-based parent visit check-ins and authorized caseworker review.

## What it does

- Parent and caseworker accounts with Supabase Auth
- Explicit **Confirm location** action using the browser Geolocation API
- High-accuracy GPS request with recorded accuracy radius
- Server-generated timestamps stored in PostgreSQL
- Optional **virtual check-in** workflow with caseworker review
- 45-minute cadence display with a 10-minute grace period
- Weekly / monthly / yearly / all-time history
- CSV export for records
- Caseworker-parent linking through expiring 6-character invite codes
- Caseworker dashboard for multiple linked parents
- Location map for submitted GPS check-ins
- Row Level Security so unrelated accounts cannot see one another's data
- Mobile/PWA-friendly interface for iPhone, Android, tablets, and desktop

## Architecture

GitHub Pages hosts only the static frontend. **Supabase** provides authentication and the PostgreSQL database. This is necessary because GitHub Pages cannot securely store multi-user check-in history or enforce caseworker access by itself.

The public Supabase `anon` key in `config.js` is expected in a browser app. Security depends on enabling the Row Level Security policies in `supabase.sql`. Never place a Supabase `service_role` key in this repository.

## 1. Create the backend

1. Create a new Supabase project.
2. Open **SQL Editor**.
3. Paste the entire contents of `supabase.sql` and run it once.
4. In **Authentication > URL Configuration**, add your GitHub Pages URL to the allowed redirect/site URLs if email confirmation is enabled.
5. Decide whether email confirmation should be required for new accounts.

## 2. Configure the frontend

Open `config.js` and replace:

- `https://YOUR_PROJECT.supabase.co`
- `YOUR_SUPABASE_ANON_KEY`

with the values shown under your Supabase project's API settings.

Do **not** put the service-role key in `config.js`.

## 3. Publish on GitHub Pages

Keep these files at the repository root:

- `index.html`
- `styles.css`
- `app.js`
- `config.js`
- `manifest.json`
- `sw.js`
- `supabase.sql` (can remain in the repo for reference)

Then in GitHub:

1. Open repository **Settings > Pages**.
2. Choose **Deploy from a branch**.
3. Select `main` and `/ (root)`.
4. Save.
5. Open the generated `https://YOUR-NAME.github.io/YOUR-REPO/` URL.

Browser geolocation requires HTTPS; GitHub Pages provides HTTPS.

## Suggested workflow

### Caseworker
1. Create a caseworker account.
2. Press **Create parent invite**.
3. Send the six-character code directly to the parent.
4. Once linked, the parent's records appear on the dashboard.
5. Location records can be opened on a map.
6. Virtual check-ins can be marked Verified or Rejected.
7. Export the displayed history as CSV when needed.

### Parent
1. Create a parent account.
2. Enter the caseworker's invite code.
3. At the required interval, press **Confirm location** and permit precise location access.
4. The check-in captures location only at that moment; it does not continuously track the phone.
5. If a virtual check-in is appropriate under the case plan, submit it for caseworker review.

## Important reliability notes

### 45-minute reminders
The dashboard countdown is precise while the page/app is active. Browsers—especially iOS—do not guarantee that JavaScript or service workers can wake up every 45 minutes after the app is closed. For court-critical reminders, use a phone alarm/calendar as a backup or add a server-side SMS/push reminder service later.

### Location is evidence, not infallible proof
Browser GPS records can document what a device reports, including its accuracy radius, but a web app alone cannot prove who physically possessed the phone or make GPS impossible to spoof. Do not represent the system as forensic or tamper-proof unless it has undergone an appropriate security/evidentiary review.

### Court orders control
The app does not change, interpret, waive, or override an order of protection or visitation order. Only use virtual check-ins, communication, or physical locations that are permitted by the actual court order and caseworker instructions.

## Production hardening recommended before agency deployment

- Have the agency/court approve the workflow and retention policy.
- Use organization-managed caseworker accounts rather than open self-signup.
- Add MFA for caseworkers.
- Add a restricted server-side RPC for virtual-review updates so only review columns can change.
- Configure database backups and retention.
- Create formal audit-event records for sign-in, invite creation, relationship changes and review actions.
- Add account suspension / transfer procedures when a worker changes cases.
- Add a server-side reminder system (SMS/push/email) if missed alerts have consequences.
- Consider a custom domain and agency privacy notice.
- Conduct a privacy/security review before storing sensitive family-court records at scale.

## Data retention

The UI intentionally has no delete button for check-ins. Supabase administrators can still implement an agency-approved retention/deletion process. Long-term location history is sensitive; retain only as long as the governing court/agency policy permits.
