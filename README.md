# Nontobeko Ngcobo — Appointment Booking System

A fully POPIA-compliant appointment booking system for a clinical psychologist practice.

---

## Pages & URLs

| Page | URL | Who uses it |
|---|---|---|
| Patient booking portal | `/` | Patients |
| Admin dashboard | `/admin.html` | Practitioner |
| Privacy notice | `/privacy.html` | Patients |
| Data subject rights | `/rights.html` | Patients |

---

## Step 1 — Create a GitHub account and upload the code

1. Go to **https://github.com** and sign up for a free account
2. Click the **+** icon → **New repository**
3. Name it `ngcobo-booking`, leave it **Public**, click **Create repository**
4. On the next page click **"uploading an existing file"**
5. Unzip the downloaded file on your PC, open the `ngcobo-booking` folder, **select all files** inside it and drag them into the GitHub upload page
6. Scroll down and click **Commit changes**

---

## Step 2 — Deploy to Render (free hosting)

1. Go to **https://render.com** and sign up using your GitHub account
2. Click **New +** → **Web Service**
3. Click **Connect a repository** → select `ngcobo-booking`
4. Fill in these settings:

| Setting | Value |
|---|---|
| Name | `ngcobo-booking` |
| Environment | `Node` |
| Build command | `npm install` |
| Start command | `node src/server.js` |
| Instance type | **Free** |

5. Click **Advanced** → **Add Environment Variable** and add each of the following:

```
NODE_ENV            → production
JWT_SECRET          → (go to https://passwordsgenerator.net, set 64 chars, click Generate)
ENCRYPTION_KEY      → (generate ANOTHER different 64-char string)
ADMIN_EMAIL         → nontobeko@simlamedical.co.za
ADMIN_PASSWORD      → (choose a strong password — you will use this to log into /admin.html)
PRACTICE_NAME       → Nontobeko Ngcobo – Clinical Psychologist
PRACTICE_PHONE      → 0843090111
PRACTICE_ADDRESS    → Simla Medical Centre, Belhar, Cape Town
PRACTICE_EMAIL      → nontobekorn@gmail.com
INFO_OFFICER_NAME   → Nontobeko Ngcobo
INFO_OFFICER_EMAIL  → nontobekorn@gmail.com
```

6. Click **Create Web Service**
7. Render will build and deploy your app (takes ~2 minutes)
8. Your live URL will be something like: `https://ngcobo-booking.onrender.com`

---

## Step 3 — Set up email confirmations (Gmail)

This lets the system send booking confirmations, cancellation emails, and reminders.

1. Log in to Gmail
2. Click your profile picture → **Manage your Google Account**
3. Go to the **Security** tab
4. Scroll down and turn on **2-Step Verification** (if not already on)
5. Search for **App passwords** in the search bar at the top
6. Select **Mail** as the app, click **Generate**
7. Copy the 16-character password shown (e.g. `abcd efgh ijkl mnop`)
8. Go to your Render dashboard → your service → **Environment** tab → add:

```
SMTP_HOST    → smtp.gmail.com
SMTP_PORT    → 587
SMTP_USER    → your_gmail@gmail.com
SMTP_PASS    → abcdefghijklmnop   (the 16 chars, no spaces)
EMAIL_FROM   → Nontobeko Ngcobo <your_gmail@gmail.com>
```

9. Render will automatically redeploy with the new settings

---

## Step 4 — Set up WhatsApp reminders (optional, Twilio)

1. Go to **https://twilio.com** and sign up for a free account
2. From the Twilio Console home page, copy your **Account SID** and **Auth Token**
3. In Twilio, go to **Messaging → Try it out → Send a WhatsApp message**
4. Note the sandbox number (e.g. `+1 415 523 8886`) — this is `TWILIO_WHATSAPP_FROM`
5. Add to Render environment variables:

```
TWILIO_ACCOUNT_SID   → ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN    → your_auth_token_here
TWILIO_WHATSAPP_FROM → whatsapp:+14155238886
```

> **Important (free trial only):** Each patient must send `join <sandbox-word>` to the Twilio sandbox number from their phone ONCE before they can receive messages. This restriction is removed when you upgrade to a paid Twilio account (~$15/month).

---

## Step 5 — Set up Google Calendar sync (optional)

This automatically adds bookings to Nontobeko's Google Calendar.

### 5a. Create a Google Cloud project

1. Go to **https://console.cloud.google.com**
2. Click **Select a project** → **New Project** → name it `ngcobo-booking` → **Create**
3. In the search bar type **"Google Calendar API"** → click it → click **Enable**

### 5b. Create a service account

1. Go to **IAM & Admin → Service Accounts** → **Create Service Account**
2. Name it `ngcobo-calendar` → click **Create and Continue** → click **Done**
3. Click on your new service account → go to the **Keys** tab
4. Click **Add Key → Create new key → JSON** → download the file
5. Open the downloaded JSON file — you need `client_email` and `private_key`
6. Add to Render environment variables:

```
GOOGLE_CLIENT_EMAIL  → ngcobo-calendar@your-project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY   → -----BEGIN RSA PRIVATE KEY-----\nMII...(paste full key, keep \n)
```

### 5c. Share your Google Calendar with the service account

1. Open **https://calendar.google.com**
2. Find your calendar in the left panel → click the 3 dots → **Settings and sharing**
3. Scroll to **Share with specific people** → click **Add people**
4. Paste the `GOOGLE_CLIENT_EMAIL` value → set permission to **Make changes to events** → **Send**
5. Scroll up to **Integrate calendar** → copy the **Calendar ID** (looks like `xxx@group.calendar.google.com`)
6. Add to Render:

```
GOOGLE_CALENDAR_ID   → xxxxxxxxxxxxxxxxxxxxxxxx@group.calendar.google.com
```

---

## Step 6 — Keep the free app awake (important for Render free tier)

Render's free tier pauses your app after 15 minutes of no traffic. Fix this for free:

1. Go to **https://uptimerobot.com** → sign up free
2. Click **Add New Monitor**
3. Set type to **HTTP(S)**
4. Paste your app URL + `/api/services`: `https://ngcobo-booking.onrender.com/api/services`
5. Set interval to **every 14 minutes**
6. Click **Create Monitor**

Your app will now stay awake 24/7 at no cost.

---

## Step 7 — Done! Test your live app

1. Open `https://ngcobo-booking.onrender.com` — try booking an appointment
2. Open `https://ngcobo-booking.onrender.com/admin.html` — log in with your ADMIN_EMAIL and ADMIN_PASSWORD
3. Check that you received a confirmation email
4. Visit `https://ngcobo-booking.onrender.com/privacy.html` to see the POPIA privacy notice

---

## POPIA compliance summary

| POPIA Section | Requirement | Implementation |
|---|---|---|
| Section 11 | Lawful basis for processing | 2 mandatory + 1 optional consent checkboxes with full legal text |
| Section 14 | Retention limitation | Auto-anonymisation after 5 years, runs on every startup |
| Section 18 | Openness | Full privacy notice at `/privacy.html` |
| Section 19 | Security safeguards | AES-256-GCM encryption, HTTPS, JWT auth, rate limiting |
| Section 22 | Breach notification | Security event log in admin dashboard |
| Section 23 | Right of access | Self-service at `/rights.html` |
| Section 24 | Right to correction | Self-service at `/rights.html` |
| Section 24(2)(b) | Right to deletion | Self-service at `/rights.html` (anonymises records) |
| Section 26 | Special Personal Information | Separate explicit consent checkbox for health data, encrypted at rest |
| Section 55 | Information Officer | Named officer details in privacy notice and all email footers |

---

## Running locally (no cloud needed)

```bash
# Install Node.js from https://nodejs.org first, then:
npm install
cp .env.example .env
# Edit .env with your settings
npm start
# Open http://localhost:3000
```

---

## File structure

```
ngcobo-booking/
├── public/
│   ├── index.html        Patient booking portal
│   ├── admin.html        Admin dashboard
│   ├── privacy.html      POPIA privacy notice
│   └── rights.html       Data subject rights portal
├── src/
│   ├── server.js         Express app entry point
│   ├── popia/
│   │   └── compliance.js POPIA engine (encryption, consent, DSR, retention)
│   ├── routes/
│   │   ├── public.js     Booking API + DSR endpoints
│   │   └── admin.js      Admin API (JWT protected)
│   ├── services/
│   │   ├── availability.js  Slot generation
│   │   ├── notifications.js Email + WhatsApp
│   │   ├── scheduler.js     Reminder scheduler
│   │   └── calendar.js      Google Calendar sync
│   ├── middleware/
│   │   └── auth.js       JWT verification
│   └── data/
│       └── store.js      JSON file datastore
├── .env.example          All environment variable names
├── render.yaml           Render.com deployment config
└── README.md             This file
```
