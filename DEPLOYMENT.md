# FleetAxis Backend Deployment Guide

## What you're about to do

Take your static GitHub Pages site and turn it into a real app with:
- Live FMCSA carrier lookup (real data from a real API)
- Email signups that actually save to a database
- "Watch this carrier" functionality that stores user watchlists

**Estimated time tonight: 60–90 minutes for first deployment.**

The first deployment is the slowest part because you're learning the workflow. Future deployments will take 30 seconds.

---

## Before you start

**Have ready:**
1. Your GitHub account (already done)
2. Your AWS account (we'll skip for now)
3. Your FMCSA webkey (rotated and saved in a password manager — do this BEFORE you continue if you haven't)
4. About 90 minutes of uninterrupted time

**You'll need to create accounts for:**
- Vercel (free)

That's it. One new account.

---

## Phase 1 — Set up Vercel (15 minutes)

### Step 1.1 — Create a Vercel account

1. Open browser, go to **vercel.com**
2. Click **"Sign Up"** in the top right
3. Click **"Continue with GitHub"** — this links your accounts automatically
4. Authorize Vercel to access your GitHub when prompted
5. When asked "Which plan?" → choose **Hobby** (free)
6. When asked for your name/team name → use **fleetaxis** or your name
7. Skip any "Get started" tutorials by clicking the dashboard link

You should land on your Vercel dashboard. It'll be empty — that's correct.

### Step 1.2 — Verify your GitHub connection

1. In Vercel, go to **Settings** (top-right avatar → Settings)
2. Click **Integrations** in the left sidebar
3. Look for **GitHub** — should say "Connected"
4. If it doesn't, click "Connect" and authorize again

---

## Phase 2 — Create a new GitHub repo for the full app (20 minutes)

We're starting a NEW repo because the old one has only static HTML. The new one will have your frontend AND backend together — Vercel works best with this layout.

### Step 2.1 — Download the project files

I've prepared all the files. Download them from this chat (look for the file downloads after this guide).

Files you'll download:
- `package.json` (project manifest)
- `vercel.json` (Vercel config)
- `.gitignore` (protects secrets)
- `.env.example` (template for environment variables — do NOT commit a real .env)
- `api/lookup.js` (FMCSA carrier lookup endpoint)
- `api/subscribe.js` (newsletter signup endpoint)
- `api/save-carrier.js` (watchlist endpoint)
- `lib/fmcsa.js` (FMCSA API helper)
- `lib/schema.sql` (database schema)
- `public/index.html` (updated homepage)
- `public/logo.png`
- `public/fleetaxis-carriers.html`
- `public/fleetaxis-brokers.html`
- `public/fleetaxis-partners.html`
- `DEPLOYMENT.md` (this guide — keep for reference)

### Step 2.2 — Organize the files on your computer

1. Open File Explorer
2. Navigate to your `Documents/fleetaxis/` folder (the one we created earlier)
3. Create a new folder inside called `app` (full path: `Documents/fleetaxis/app/`)
4. Inside `app`, create two subfolders:
   - `api`
   - `lib`
   - `public`
5. Sort the downloaded files into the right folders:
   - **Top level (in `app/`):** `package.json`, `vercel.json`, `.gitignore`, `.env.example`, `DEPLOYMENT.md`
   - **In `app/api/`:** `lookup.js`, `subscribe.js`, `save-carrier.js`
   - **In `app/lib/`:** `fmcsa.js`, `schema.sql`
   - **In `app/public/`:** `index.html`, `logo.png`, all the other HTML files

Final layout:
```
Documents/fleetaxis/app/
├── api/
│   ├── lookup.js
│   ├── subscribe.js
│   └── save-carrier.js
├── lib/
│   ├── fmcsa.js
│   └── schema.sql
├── public/
│   ├── index.html
│   ├── logo.png
│   ├── fleetaxis-carriers.html
│   ├── fleetaxis-brokers.html
│   └── fleetaxis-partners.html
├── .gitignore
├── .env.example
├── package.json
├── vercel.json
└── DEPLOYMENT.md
```

### Step 2.3 — Create new GitHub repo

1. Go to **github.com**
2. Click **"+"** in top-right → **"New repository"**
3. Name it: **fleetaxis-app**
4. Description: "FleetAxis full application"
5. Choose: **Private** (we'll change later if needed)
6. Don't check any boxes about README/gitignore (we have our own)
7. Click **"Create repository"**

You'll see a page with setup instructions. Don't follow those yet.

### Step 2.4 — Push files to GitHub

The easiest way is via GitHub Desktop (which you already have):

1. Open **GitHub Desktop**
2. File menu → **"Add local repository"**
3. Browse to `Documents/fleetaxis/app/`
4. Click **"create a repository"** when prompted (since it's not yet a Git repo)
5. In the dialog: name = `fleetaxis-app`, leave defaults, click **"Create Repository"**
6. Now click **"Publish repository"** at the top
7. UNCHECK "Keep this code private" if you want it public, OR keep checked for private
8. Click **"Publish Repository"**

Your code is now on GitHub. Verify by going to github.com — you should see your new repo with all the files.

---

## Phase 3 — Connect Vercel to your repo (10 minutes)

### Step 3.1 — Import the repo

1. In Vercel dashboard, click **"Add New..."** → **"Project"**
2. You should see your `fleetaxis-app` repo
3. Click **"Import"** next to it
4. **DON'T deploy yet** — first we configure environment variables

### Step 3.2 — Set up environment variables

Before deploying, we need to give Vercel your FMCSA webkey safely.

1. On the import screen, expand **"Environment Variables"**
2. Add a variable:
   - Name: `FMCSA_WEBKEY`
   - Value: paste your FMCSA webkey here
3. Click **"Add"**

(We'll add the database variables in the next phase.)

### Step 3.3 — Click Deploy

1. Click the **"Deploy"** button
2. Wait ~2 minutes
3. Vercel will show a celebration screen with confetti
4. Note the URL it gives you — something like `fleetaxis-app.vercel.app`

**Visit that URL.** You should see your homepage. Try a lookup with USDOT 2589042. **It might fail** because we haven't added the database yet — that's expected. We'll fix it next.

---

## Phase 4 — Set up the database (15 minutes)

### Step 4.1 — Create the Neon Postgres database

1. In your Vercel project, click the **"Storage"** tab at the top
2. Click **"Create Database"**
3. Select **"Neon"** (Postgres) from the Vercel Marketplace
4. Name: `fleetaxis-db`
5. Region: pick whatever's closest to you
6. Click **"Create"** and connect it to this project

Vercel will connect the Neon database to your project and add a Postgres connection string such as `DATABASE_URL` (legacy projects may still expose `POSTGRES_URL`). The app accepts either variable.

### Step 4.2 — Initialize the schema

1. After creation, click on the database
2. Find the **"Query"** tab at the top
3. Open the `lib/schema.sql` file from your project
4. Copy ALL the SQL
5. Paste it into the Query box
6. Click **"Run Query"** (or whatever the Vercel UI calls it)
7. You should see "Success" or table names listed

The 3 tables (`subscribers`, `saved_carriers`, `lookup_log`) now exist.

### Step 4.3 — Redeploy

After the database environment variables are connected to your project, trigger a redeploy:

1. Go to **Deployments** tab
2. Find the most recent deployment
3. Click the three-dot menu → **"Redeploy"**
4. Confirm — wait ~1 minute

After redeploy, visit your site. **Try a lookup with USDOT 2589042 (Mahant Transportation).** You should see real data populate the dashboard.

---

## Phase 5 — Connect your domain (10 minutes)

### Step 5.1 — Add fleetaxis.com to Vercel

1. In your Vercel project, go to **Settings** → **Domains**
2. Type **fleetaxis.com** and click **Add**
3. Vercel shows you DNS records to add

### Step 5.2 — Update DNS at your domain registrar

Where did you buy fleetaxis.com? GoDaddy, Namecheap, Google Domains, somewhere else?

Whichever it is, log in there and find the DNS settings.

You'll need to add (or update):
- An **A record** pointing to Vercel's IP
- OR a **CNAME** record pointing to `cname.vercel-dns.com`

Vercel shows you the exact records to add. Just copy them.

DNS changes take 5 minutes to a few hours to propagate. Vercel will show "Valid Configuration" with a green checkmark when ready.

### Step 5.3 — (Optional) Add www.fleetaxis.com too

Repeat Step 5.1 but with `www.fleetaxis.com`. Vercel handles the redirect automatically.

---

## Phase 6 — Test everything end-to-end (10 minutes)

### Step 6.1 — Lookup test

1. Visit fleetaxis.com (or your vercel.app URL if DNS not propagated yet)
2. Type **2589042** and click **Look up**
3. You should see Mahant's REAL data — pulled live from FMCSA
4. Try a different carrier you know — type their USDOT number
5. Try a bad number like 999999999 — you should get a "not found" message

### Step 6.2 — Newsletter test

1. Scroll to the bottom of the homepage
2. Enter your email in the newsletter form
3. Click **Get early access**
4. You should see a green confirmation message

### Step 6.3 — Verify the database has the email

1. Go back to Vercel → Storage → fleetaxis-db → Query tab
2. Run: `SELECT * FROM subscribers;`
3. Your email should appear

### Step 6.4 — Watchlist test

1. Look up a carrier (like 2589042)
2. Click the **"+ Watch this carrier"** button
3. Enter your email when prompted
4. You should see a confirmation alert
5. Verify in DB: `SELECT * FROM saved_carriers;`

If all four tests pass — you're live with a real backend. 🎉

---

## What if something breaks?

### "Carrier not found" for a valid USDOT
Your FMCSA webkey may not be active yet, or it's wrong. Check:
1. Vercel → Settings → Environment Variables → `FMCSA_WEBKEY` is set
2. Try the FMCSA API directly in browser:
   `https://mobile.fmcsa.dot.gov/qc/services/carriers/2589042?webKey=YOURKEYHERE`
3. If that returns data in browser but your site doesn't, redeploy

### Newsletter signup says "Network error"
1. Vercel → Storage — is the DB created?
2. Vercel → Settings → Environment Variables — are POSTGRES_* variables set?
3. Did you run the schema.sql query?

### Site not loading at all
1. Vercel → Deployments — most recent deployment status?
2. Click into the deployment for build logs
3. Look for red error text

### Ugly errors in browser console (F12)
Take a screenshot, paste the errors, send them to me. Most are easy fixes.

---

## What's NOT done yet (next sessions)

- **Daily monitoring** — checking watched carriers for changes and emailing alerts. Requires a scheduled job.
- **Real email confirmation flow** — currently the "subscribe" just stores the email. We should send a confirmation email (CAN-SPAM best practice).
- **Privacy policy** — required before public launch. Use Termly.io (free).
- **User accounts / login** — to give users a real dashboard with their saved carriers. Currently watchlist is keyed by email only.
- **AWS migration plan** — eventually we'll move pieces to AWS for scale.

But none of those are needed tonight. Tonight is about **proving real data flows end-to-end.**

---

## After this works

**DON'T** share the URL widely yet. Test for a few days with friendly contacts only. Specifically:

1. Send to Emran for code review
2. Send to 2-3 trusted trucking contacts for product feedback
3. Send to Mahant ONLY when ready for a serious beta conversation

Once it's stable for 5+ days with no breaks, you can start sharing more publicly.

Good luck tonight. You've got this.
