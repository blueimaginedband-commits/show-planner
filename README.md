# Show Planner

A small shared website for a band: a **shows itinerary** (venue, load-in, soundcheck, doors, set times, contact, deal, notes) and an **availability calendar** where everyone marks the dates they're Free, Maybe or Busy. It suggests the best open dates to book and shows who can make each gig.

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
