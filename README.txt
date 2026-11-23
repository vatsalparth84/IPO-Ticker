IPO TICKER - setup
==================
Files: index.html, manifest.json, sw.js, icon-*.png, ipos.json, details/ (one file per IPO), scripts/sync.mjs, .github/workflows/sync-ipos.yml
(keep the folder structure exactly as it is - the .github folder is hidden on some computers, make sure it is uploaded)

CAN I JUST UPLOAD THE ZIP?
  - Quick start (no auto-updates): unzip, then drag the FOLDER into Netlify Drop (app.netlify.com/drop) or Cloudflare Pages
    "Direct Upload". You get a working https link in a minute, with the starter IPO list. It will NOT refresh by itself,
    because those drop-uploads cannot run the 30-minute update job.
  - Full version (auto-updating IPO list + details): use GitHub, steps below. This is the one to use long term.
  - It is a web app (PWA), not an APK. On the phone, open the link and use "Add to Home Screen" - it then opens full-screen like an app.

WHAT IT DOES
  - Applications tab: tick accounts per IPO, "Save" keeps your progress, "IPO completed" moves the IPO to the History tab.
  - History tab: every IPO you applied for, with accounts, quantity x bid, amounts and date. Reopen / Delete from there.
  - History is stored on this device/browser only (clearing browser data erases it).
  - Tap any IPO for its full detail page (timeline, GMP, subscription, lot sizes, reservation, valuations, financials, about, contact), same order as IPO Ji.
  - Open IPOs and Upcoming IPOs (with dates, or "dates not announced yet"), Mainboard + SME, with company logos.
  - The IPO list is NOT typed in by hand: a small job reads IPO Ji every 30 minutes and updates ipos.json.
    When a new IPO appears there, it appears in the app on its next refresh.
  - Your accounts, ticks and amounts stay on each device (localStorage). They are not synced between devices.

ONE-TIME SETUP  (free, about 10 minutes)
  1. Create a free account on github.com and make a new repository (public is fine).
  2. Upload everything in this folder to it (drag & drop in "Add file > Upload files"; the .github folder must go too).
  3. Repo > Settings > Pages > Source: "Deploy from a branch" > main / (root) > Save.
     Your app is then live at  https://<your-username>.github.io/<repo-name>/
     (Netlify / Cloudflare Pages / Vercel also work: connect them to the same repo instead of Pages.)
  4. Repo > Actions tab > "Sync IPO list" > Run workflow. Watch it turn green (about 30 seconds).
     From now on it runs by itself every 30 minutes.
  5. On your phone: open the site > browser menu > "Add to Home Screen".

IF SOMETHING LOOKS WRONG
  - The app shows "Live list updated <time>" under Open IPOs, with a tick or cross for each source.
    A warning appears if the list is more than 6 hours old (the job has stopped).
  - Run the job by hand: Actions > Sync IPO list > Run workflow. A red run shows the reason in its log.
  - GitHub pauses scheduled jobs on repositories with no activity for 60 days; if it emails you about that,
    open the Actions tab and press "Enable".
  - IPO Premium blocks automated visitors, so its tick may show a cross; IPO Ji is the main source and keeps working.
  - If IPO Ji ever redesigns its pages and the job fails, the app keeps showing the last good list.

Notes
  - Logos are loaded straight from IPO Ji's image server; if one cannot load, a letter badge is shown instead.
  - "Add IPO manually" still works for anything the list does not have yet.
  - HTTPS is required for "Add to Home Screen" (GitHub Pages and the others give you that automatically).
  - Updating the app: replace the files in the repo; it picks up the new version on the next open.
