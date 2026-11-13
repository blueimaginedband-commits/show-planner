# Show Planner

A small shared website for a band:

- **Shows:** venue, load-in, soundcheck, doors, set times, contact, deal and notes for every gig.
- **Itinerary:** a day-of timeline for each show that mixes the venue times with your own steps (meet up, leave, dinner, load-out, hotel). One tap copies it as text for the group chat.
- **Best rehearsal times:** tap a day to see its top time windows ranked by how many people can make them (with who's in and who's missing), plus a chart of everyone's free hours. The side list shows each day's best window for the next 60 days. One tap plans a practice in that window.
- **Practices:** plan rehearsals (date, time, place, what to work on) alongside shows.
- **Availability:** everyone marks dates Free, Maybe or Busy, optionally with a time window like "after 6 PM" or "until 10 PM". It suggests the best open dates and flags anyone who'd miss load-in or leave before the set ends.

- No accounts. Bandmates open the link, enter the band passcode once, and pick their name.
- Updates from other people appear within about 5 seconds.
- Zero dependencies: plain Node.js (18+). Data is saved to one JSON file.

## Deploy on Railway (from GitHub)

1. **Push this folder to a GitHub repo.** Create an empty repo on github.com (e.g. `show-planner`), then from this folder run:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/show-planner.git
   git push -u origin main
   ```
2. **Create the Railway service.** On [railway.com](https://railway.com): **New Project → Deploy from GitHub repo**, then pick `show-planner`. Railway detects Node and runs `npm start`.
3. **Add a volume so data survives redeploys.** In the service, open **Settings → Volumes** (or right-click the service → *Attach volume*) and mount it at `/data`. The app finds the volume automatically. **Without a volume, every redeploy wipes your shows and availability.**
4. **Set variables** under **Variables**:
   | Variable | Example | What it does |
   |---|---|---|
   | `PASSCODE` | `greenroom42` | Required to view or edit. Leave it unset and anyone with the link can edit. |
   | `BAND_NAME` | `Blue Imagined` | Title shown at the top. |
5. **Get a public URL:** **Settings → Networking → Generate Domain**. Send that link and the passcode to your bandmates.

Every push to `main` redeploys automatically.

## Privacy

Everything except the sign-in screen needs the passcode. The site also tells search engines not to index it (`robots.txt` and `noindex`), so it won't show up in Google.

## Run it locally

```bash
PASSCODE=test BAND_NAME="My Band" npm start
# open http://localhost:3000
```

Data goes to `./data/data.json` locally (ignored by git). Set `DATA_DIR` to put it elsewhere.

## Backups

All data is in `data.json` on the volume. To back it up, use Railway's volume backups, or fetch it with the passcode:

```bash
curl -H "x-passcode: YOUR_PASSCODE" https://YOUR-APP.up.railway.app/api/state > backup.json
```

## Files

- `server.js`: the web server and JSON API
- `public/index.html`, `public/app.js`, `public/styles.css`: the site
- `railway.json`: start command and health check for Railway
