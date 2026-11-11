# US Open results reader

Reads the public UKI results page (results.gacsystems.com) the way a visitor's browser does, picks out results for dogs in the tracker's entries, and publishes them as the tracker's `results.json` on Spacefast (bright-harbor.space.fast). Only that one file changes; the tracker page and alerts already read it.

## Set up (one time)

1. Create a **public** GitHub repository (public repos get unlimited free Actions minutes) and add these files, keeping the folders:
   - `reader.mjs`, `match.mjs`, `publish.mjs`, `package.json`, `package-lock.json`
   - `test/match.test.mjs`, `test/fixture.mjs`
   - `.github/workflows/read-results.yml`
2. In Spacefast, create an API key limited to the **Bright Harbor** space with permission to **publish** and **promote versions**. Give it an expiry after the event (e.g. Nov 24).
3. In the GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `SPACEFAST_API_KEY`
   - Value: the key from step 2
4. **Actions** tab → enable workflows.

## When it runs

Every hour from Nov 18–22, roughly 6 AM to 10 PM Eastern. Each run keeps checking every 90 seconds for 55 minutes and only posts when something changed.

## Before the event: tune it once results appear

The results site shows nothing until GAC publishes the event. When the US Open appears (likely Nov 17–18):

Actions → **Read US Open results** → **Run workflow** with *minutes = 0*, *snapshot = on*, *dry run = on*.

Download the **snapshots** artifact. It holds the text and a screenshot of each screen the reader saw, which shows exactly how their results are laid out so the matching rules can be adjusted.

## Safety checks

Each update is built as a new version first, checked (all 14 site files present, server code intact) and only then made live. If the check fails, the live site is left alone. Results already published are never dropped; unchanged results keep their original time, so alerts fire only on real changes. To undo, promote an earlier version in Spacefast.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVENT_MATCH` | `US Open` | Text that identifies the event on the results home screen |
| `POLL_SECONDS` | `90` | Pause between checks (minimum 45) |
| `RUN_MINUTES` | `55` | How long one run keeps checking |
| `DRY_RUN` | off | Read and print, don't post |
