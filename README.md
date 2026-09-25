# Family Visit Compliance — GitHub Pages + Render + Supabase

A mobile-first, consent-based visit documentation system for structured parent/caseworker check-ins.

## Architecture

- **GitHub Pages:** static parent/caseworker frontend and PWA.
- **Render:** stateless Node/Express API, access validation, WebRTC signaling, report generation/email. It does **not** persist family, visit, GPS, or call media data.
- **Supabase:** long-term system of record for cases, participants, visits, check-ins and report-delivery status.
- **WebRTC:** encrypted browser-to-browser audio/video. Render relays signaling only. No call recording is implemented.
- **Resend (optional):** sends finalized visit PDF + CSV to the supervisor configured in Render.

## Visit workflow

1. Parent opens the GitHub Pages frontend and chooses **Parent**.
2. Parent enters assigned case code, exact display name and access PIN. No email/password account is used.
3. First parent selects **Start / Join 120-minute visit**. A second parent on the same case can join the same active visit.
4. Each parent can submit explicit GPS, virtual or video-device check-ins. GPS is requested only when the parent presses the location button.
5. At the second total check-in, the visit becomes **Review Ready**. Nothing is automatically labeled compliant.
6. A caseworker signs in on the same frontend, reviews the check-ins and marks the visit **Compliant** or **Non-compliant**.
7. The finalized result remains in Supabase. Render generates a PDF and CSV and, if email delivery is configured, sends both to the supervisor.

## 1. Supabase

Create a Supabase project and run `supabase.sql` in the SQL editor.

The browser does **not** receive a Supabase key. All database access goes through Render using the service-role key, and all tables have RLS enabled with no public policies.

### Create the case and PINs

Install server dependencies locally:

```bash
npm install
node scripts/hash-pin.mjs 123456
```

Copy the bcrypt output into `SETUP.sql.example`, replace the case UUID/names, and run those inserts in Supabase. Use separate PINs for each participant.

## 2. Render backend

Push the whole repository to GitHub, then create a Render Web Service from the **same repo**, or use `render.yaml`.

Required environment variables:

- `JWT_SECRET` — long random secret; `render.yaml` can generate it.
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — backend only. Never put this in `config.js`.
- `FRONTEND_ORIGINS` — e.g. `https://YOURNAME.github.io`

Supervisor report email:

- `RESEND_API_KEY`
- `REPORT_FROM` — must use a sender/domain accepted by your email provider.
- `SUPERVISOR_EMAIL` — destination for every finalized visit report.

WebRTC production reliability:

- `TURN_URL`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

STUN is included by default. A TURN relay is strongly recommended before court/agency production because peer-to-peer WebRTC can fail on restrictive cellular, agency or enterprise networks. TURN credentials can be from a service such as Twilio Network Traversal, Metered, Cloudflare TURN, or your own coturn server.

Check:

`https://YOUR-RENDER-SERVICE.onrender.com/healthz`

It should return JSON containing `"ok": true`.

## 3. GitHub Pages frontend

Edit `config.js`:

```js
window.APP_CONFIG = {
  API_URL: "https://YOUR-RENDER-SERVICE.onrender.com",
  VISIT_MINUTES: 120,
  CHECKIN_INTERVAL_MINUTES: 45,
  REMINDER_GRACE_MINUTES: 10,
  APP_NAME: "Family Visit Compliance"
};
```

In GitHub: **Settings → Pages → Deploy from branch → main → /(root)**.

HTTPS is required for browser camera, microphone and precise geolocation outside localhost. GitHub Pages supplies HTTPS.

## iPhone installation

1. Open the GitHub Pages URL in **Safari**.
2. Tap **Share**.
3. Tap **Add to Home Screen**.
4. Open the installed icon.
5. When used, allow Location, Camera and Microphone.

The app also contains an **Add to Home** button that displays these directions on iOS.

## Android installation

Chrome/Edge can show a native PWA install prompt. Otherwise use browser menu → **Install app** / **Add to Home screen**.

## Camera and calls

The **Camera / Mic** button tests browser permissions without uploading a recording. Calls use `getUserMedia` and `RTCPeerConnection` with Socket.IO only for offer/answer/ICE signaling. The application intentionally does not record or store call audio/video.

## Important production notes

- This system records what a device submits. GPS may be inaccurate or spoofed and does not independently prove who possessed the device.
- Do not claim a virtual/video call is recorded unless you separately implement lawful recording with appropriate notice/consent.
- Use separate participant PINs and rotate a PIN immediately if exposed.
- Keep Render's service-role key and JWT secret out of GitHub.
- Use a paid/always-on Render instance for a production court workflow if cold starts would be unacceptable.
- Use TURN before depending on WebRTC across unknown mobile/agency networks.
- Test iPhone Safari, Android Chrome, desktop Chrome/Edge/Safari, GPS, report email, and both sides of calling with the actual deployment before operational use.

## Files

- `index.html`, `styles.css`, `app.js`, `config.js` — GitHub Pages frontend
- `manifest.json`, `sw.js`, `assets/` — installable PWA
- `server/server.js` — stateless Render API + WebRTC signaling
- `supabase.sql` — database schema
- `SETUP.sql.example` — case/participant bootstrap example
- `render.yaml` — Render blueprint
- `.env.example` — backend environment template
- `scripts/hash-pin.mjs` — PIN hashing helper
