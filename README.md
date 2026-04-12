# Rolleston Baptist Church Podcast

Automated podcast pipeline for [Rolleston Baptist Church](https://www.rollestonbaptist.org.nz/). Scrapes sermons and seminars from the church website, uploads audio to Cloudflare R2, generates episode markdown files, and publishes two RSS feeds — one for sermons, one for seminars. Built on [Astropod](https://getastropod.netlify.app) (Astro-based podcast template) and deployed to Netlify.

**Live site:** https://rbcpodcast.netlify.app  
**Sermons feed:** https://rbcpodcast.netlify.app/rss-sermons.xml  
**Seminars feed:** https://rbcpodcast.netlify.app/rss-seminars.xml

---

## How it works

1. **Discover** — scrapes `rollestonbaptist.org.nz/sitemap.xml` for message URLs, visits each page with Cheerio, and extracts title, speaker, date, series, topics, and Google Drive audio link. Results are saved to `scripts/sermon-manifest.json`.

2. **Upload** — downloads each audio file from Google Drive, parses duration with `music-metadata`, and uploads to Cloudflare R2 at `{sermons|seminars}/{series-slug}/{year}/{slug}.mp3`.

3. **Generate** — reads the manifest and writes `src/content/episode/{slug}.md` for every uploaded entry, with full frontmatter including `audioUrl`, `pubDate`, `duration`, `size`, `category`, `series`, and `speaker`.

4. **Publish** — a GitHub Actions workflow runs every Monday at 6pm NZ time, runs all three steps automatically, commits any new files, and pushes — triggering a Netlify redeploy.

**Series categorisation** — series names in the `SEMINAR_SERIES` set in `scripts/scrape-sermons.mjs` are tagged `category: seminar`; all others are `category: sermon`. The two RSS feeds filter on this field.

---

## Key files

| File                                 | Purpose                                                         |
| ------------------------------------ | --------------------------------------------------------------- |
| `scripts/scrape-sermons.mjs`         | Main scraper/uploader — discovery, upload, verify, fix-metadata |
| `scripts/generate-episodes.mjs`      | Reads manifest, writes episode `.md` files                      |
| `scripts/sermon-manifest.json`       | Source of truth — 337 entries with status, metadata, R2 keys    |
| `scripts/audio-overrides.json`       | Manual Google Drive ID overrides for pages with no audio link   |
| `scripts/.env`                       | Local R2 credentials (gitignored)                               |
| `.astropod/astropod.config.json`     | Site name, description, cover art, RSS config                   |
| `src/content/config.ts`              | Astro content schema (includes `category`, `series`, `speaker`) |
| `src/pages/rss-sermons.xml.js`       | Sermons-only RSS feed                                           |
| `src/pages/rss-seminars.xml.js`      | Seminars-only RSS feed                                          |
| `.github/workflows/sync-sermons.yml` | Weekly GitHub Actions sync workflow                             |

---

## Local setup

```sh
# Install dependencies
pnpm install

# Copy and fill in R2 credentials
cp scripts/.env.example scripts/.env

# Run a discovery pass (scrape metadata, no uploads)
pnpm sermons:discover

# Upload a specific series interactively
pnpm sermons:upload

# Upload all pending entries (no interactive prompt)
pnpm sermons:upload-all

# Backfill missing duration/size from R2
pnpm sermons:fix-metadata

# Generate episode .md files
pnpm sermons:generate

# Verify manifest against live R2 bucket
pnpm sermons:verify

# Start local dev server
pnpm dev

# Build for production
pnpm build
```

---

## R2 credentials (`scripts/.env`)

```
R2_ACCOUNT_ID=
R2_BUCKET=rolleston-baptist
R2_PUBLIC_URL=https://pub-78341e7c021e425e874803eed5498bb5.r2.dev
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```

The same five values are stored as GitHub Actions repository secrets for the automated workflow.

---

## Adding a new seminar series

If Joe starts a new seminar series that the scraper miscategorises as a sermon, add the series name to the `SEMINAR_SERIES` set in `scripts/scrape-sermons.mjs`, then run:

```sh
pnpm sermons:generate --force
git add -A && git commit -m "chore: add <series> to seminar list" && git push
```

---

## Manual audio override

If a sermon page has no Google Drive link but you have a file ID, add it to `scripts/audio-overrides.json`:

```json
{
  "https://www.rollestonbaptist.org.nz/messages/some-sermon/": "DRIVE_FILE_ID"
}
```

Then reset the entry status to `pending` in `scripts/sermon-manifest.json` and re-run `pnpm sermons:upload`.

---

## Next steps

### Immediate

- **Commit and push latest changes** — about page, workflow update, Decap removal:
  ```sh
  git add -A && git commit -m "feat: improve about page, remove decap, add failure notifications" && git push
  ```
- **Fix Luke 14:1-35 duration** — manifest has `durationSecs: null`; backfill then regenerate:
  ```sh
  pnpm sermons:fix-metadata && pnpm sermons:generate
  ```
- **Re-upload DoG Part 6** — still set to `pending` in manifest with Drive ID override ready; run `pnpm sermons:upload` and pick the _Doctrines of Grace / The Doctrine of God's Love_ series.

### Awaiting external action

- **Apple Podcasts / Spotify approval** — submitted, pending review. Once approved, add subscribe badge links to `src/pages/about.astro`.
- **Amazon Music** — submit feed at [music.amazon.com/podcasts](https://music.amazon.com/podcasts) once Apple is approved.
- **Custom domain for R2** — ask RBC if `rollestonbaptist.org.nz` is on Cloudflare. If so, add a CNAME `audio.rollestonbaptist.org.nz` pointing to the R2 bucket (removes the `r2.dev` rate-limit warning). Then:
  ```sh
  # Update R2_PUBLIC_URL in scripts/.env AND the GitHub repo secret, then:
  pnpm sermons:fix-metadata && pnpm sermons:generate --force
  git add -A && git commit -m "chore: update R2 domain" && git push
  ```

### Housekeeping

- **Rename local folder** — rename `~/Code/astropod` to `~/Code/rbcpodcast` and update the git remote:
  ```sh
  cd ~ && mv Code/astropod Code/rbcpodcast
  git -C ~/Code/rbcpodcast remote set-url origin https://github.com/tonestar/rbcpodcast.git
  ```
- **Bump GitHub Actions Node version** — actions currently use Node 20 runners (deprecated June 2026); update `actions/checkout`, `actions/setup-node`, and `pnpm/action-setup` to versions supporting Node 24 before June 2026.

---

## Potential improvements

---

## Tech stack

- [Astro](https://astro.build) + [Astropod](https://getastropod.netlify.app) — static site framework
- [Tailwind](https://tailwindcss.com) + [DaisyUI](https://daisyui.com) — styling
- [Netlify](https://netlify.com) — hosting + CI/CD
- [Cloudflare R2](https://developers.cloudflare.com/r2/) — audio storage
- [Cheerio](https://cheerio.js.org) — HTML scraping
- [music-metadata](https://github.com/borewit/music-metadata) — audio duration parsing
- [GitHub Actions](https://docs.github.com/en/actions) — weekly automation
