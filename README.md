# PROFCOM LNMU — CS2 Tournament Series

React + Vite public frontend with a separate admin entry page, Bootstrap Icons, and a Python API. The frontend can be published on GitHub Pages, while the API uses PostgreSQL on Supabase. SQLite remains available for local development.

## Run locally

Run the API locally with SQLite in one terminal:

```powershell
python backend\server.py
```

Start the frontend in another terminal:

```powershell
cd react
npm install
npm run dev
```

Open the Vite URL shown in the terminal. The Vite development server proxies `/api` requests to `http://127.0.0.1:8000`.

The local SQLite database is created automatically at `backend\tournament.sqlite3`. Team applications stay pending until approved in the admin panel.

## Deploy the API and database

1. Create a free PostgreSQL project on [Supabase](https://supabase.com/). Copy its PostgreSQL connection URI from the project's **Connect** settings; use the session pooler URI if direct connections are unavailable.
2. Push this repository to GitHub. The Pages workflow will wait for `VITE_API_BASE_URL`; configure that variable after the API has been deployed.
3. In [Render](https://render.com/), create a **Web Service** from this repository named `profcom-lnmu-api`:
   - Runtime: Python 3; region: Frankfurt; plan: Free.
   - Root directory: `backend`.
   - Build command: `pip install -r requirements.txt`.
   - Start command: `python server.py`.
   - Health check path: `/api/health`.
4. In the new Render service's environment settings, set:
   - `DATABASE_URL` to the Supabase PostgreSQL connection URI.
   - `FRONTEND_ORIGINS` to the exact public origin, e.g. `https://YOUR-USERNAME.github.io` (or your custom domain). Do not add a repository path.
   - Telegram variables as described below once the bot is ready.
5. Deploy the API and check `https://profcom-lnmu-api.onrender.com/api/health`.

The API uses PostgreSQL whenever `DATABASE_URL` is set and falls back to local SQLite otherwise. Existing local SQLite data is not automatically copied to Supabase.

Render's free API service can sleep after 15 minutes without traffic, so its first request after a pause may take around a minute. Supabase Free provides a 500 MB database and may pause projects after a week without activity. The Supabase database keeps the tournament data while paused, unlike local files on a free Render web service. These free tiers are suitable for development and a small initial launch, but include availability and usage limits.

## Deploy the frontend to GitHub Pages

1. In the GitHub repository, open **Settings → Secrets and variables → Actions → Variables** and add `VITE_API_BASE_URL`, set to `https://profcom-lnmu-api.onrender.com`.
2. Open **Settings → Pages** and set the publishing source to **GitHub Actions**.
3. Re-run the failed Pages workflow from **Actions**, or push another commit to `main`/`master`. It builds the React app and deploys `react/dist`. For a project repository, the workflow automatically handles the repository subpath.
4. Set Render's `FRONTEND_ORIGINS` to the published site origin, such as `https://YOUR-USERNAME.github.io`, and redeploy the API if needed.

## Connect the Telegram WebApp and admin

After GitHub Pages is live, configure the bot's Web App/menu button in BotFather with the site's HTTPS URL. The public frontend opens inside Telegram; it calls the Python API separately over HTTPS. Cross-origin API requests are allowed only from the origin configured in `FRONTEND_ORIGINS`.

Admin access is verified on the Python server from Telegram WebApp `initData`. Set the bot token and the comma-separated numeric Telegram user IDs allowed to administer tournaments in the Render environment:

Get the bot token from BotFather and keep it only in Render's environment—never in React code or a committed file. Rotate the bot token first if it was previously stored in project source. Add the administrator's numeric Telegram user ID (not username) to `TELEGRAM_ADMIN_IDS`. Open the WebApp in Telegram and use **Профіль → Адмін-панель**; that link appears only for configured admins. Directly opening `/admin.html` in a regular browser does not authenticate. The server validates Telegram's signature, limits `initData` to 24 hours, and checks the signed numeric user ID against `TELEGRAM_ADMIN_IDS`.

Admins create the tournament and choose whether it has standings, a playoff bracket, or both. They can approve applications, schedule matches, and enter match results. Standings and leaderboard points are calculated from completed match wins using the tournament's configured points-per-win value. The public schedule and team list start empty.

## Production build

```powershell
cd react
npm run build
```
