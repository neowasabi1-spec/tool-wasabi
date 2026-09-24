# Wasabi Saver — browser extension

Save any landing page into your Wasabi archive with one click: it captures the
page HTML + desktop and mobile screenshots and files it under the **Category**
(niche: Survival, Weight loss, …) and **Type** (Advertorial, VSL, Checkout, …)
you choose — it lands in My Archive → "By Type" — with whatever tags you want.

It also saves **creatives** (images/videos) into a project's Competitor
Library, and can enable **daily auto-scraping** of a competitor's Meta Ad
Library.

**Zero configuration.** It's already connected to your tool: just be logged in.

---

## Install (once, 4 clicks)

1. Open Chrome (or Edge) and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension` folder (this folder)

Done. Pin the "Wasabi Saver" icon to the toolbar if you like.

## How to use — landing pages

1. Open your Wasabi tool in a tab and **log in** (only once: the extension
   connects itself by reading your session).
2. Go to any landing page.
3. Click the **Wasabi Saver** icon.
4. Choose **Category** (or type a new one in the field next to it), **Type**
   (Advertorial, VSL, Checkout, …) and **tags**, then **Save**.
   The page shows up in **My Archive → By Type**: pick the category at the top
   and find it inside the card of its type.

After saving, two links appear: **open in editor** and **view HTML**.

## How to use — bulk import (AdSpends lists)

Don't save one advertorial at a time. On an AdSpends (or similar) list:

1. Open the Advertorials / Landing / Sales Pages grid.
2. Click the **Wasabi Saver** icon — Bulk turns on and **Scan** collects the
   landing URLs from the cards (or click Scan yourself / paste URLs).
3. Pick **Type** (Advertorial, Landing, …) and Category.
4. Click **Save N pages**. A small **importer window** opens and walks each
   URL (HTML + screenshots). **Leave that window open** until it says Done —
   Chrome otherwise kills the job after a few minutes (~80 pages). You can
   close the popup; use **Resume remaining pages** if it stops.

Cap is 400 URLs per run. Scan scrolls the open list; it cannot see AdSpends pages that were never loaded. Duplicates already in the archive are skipped.

## How to use — bulk import (AdSpends Ads / creatives)

The Ads grid on AdSpends is a different list (thousands of images/videos, not landing URLs).

1. Open AdSpends → **Ads** (the creatives grid, not Pages).
2. Click **Wasabi Saver** — Bulk turns on and switches to **Ads (creatives)**. **Scan** scrolls the grid and collects media.
3. Optional: pick a **Category** (niche) and extra tags. Type is automatic.
4. Click **Save N creatives**. Leave the importer window open until Done.

Each creative lands in **Template → Ads**, filed as **Image / Video / Carousel / UGC / Story** from format (9:16 → Story), media (video/image), and copy cues (UGC, carousel, …). Already imported creatives are skipped on the next Scan — it scrolls past them and queues up to 400 **new** ones. Repeat Save → Scan for the next slice. Scan only sees cards it can scroll to, not the whole AdSpends catalog.

You can also drag files onto **Upload & auto-sort** on Template → Ads.

## How to use — creatives (Competitor Library)

1. Hover any image or video on a page — a **Save** button appears.
2. Pick the **Project** and the **Competitor** (existing, auto from the site
   domain, or a new one).
3. Optionally enable **auto-scraping**, choose a **frequency**, and paste the
   competitor's **Ad Library URL** to monitor it automatically every day.
4. Click **Save**. Videos are transcribed automatically.

---

## Notes

- The first time, if the extension says "not connected", open/reload the tool
  tab (where you're logged in) and reopen the popup: it connects itself.
- While taking screenshots Chrome shows a "…is debugging this browser" bar:
  that's normal and disappears right away.
- `chrome://` or store pages can't be captured.
