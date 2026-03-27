/**
 * scrape-sermons.mjs
 *
 * Scrapes all sermons from rollestonbaptist.org.nz via their WordPress sitemap,
 * downloads audio from Google Drive, uploads to Cloudflare R2, and writes a
 * manifest JSON for later use in building episode markdown files.
 *
 * Usage:
 *   R2_ACCESS_KEY_ID=xxx R2_SECRET_ACCESS_KEY=xxx node scripts/scrape-sermons.mjs
 *
 * Flags:
 *   --discover         Scrape all pages for metadata only (no downloads/uploads).
 *                      Builds the manifest so you can inspect series before uploading.
 *   --list-series      Print all series found in the manifest with message counts, then exit.
 *   --series="Name"    Only upload messages belonging to this series name.
 *                      e.g. --series="Luke"
 *   --dry-run          Scrape and parse pages but skip all downloads and R2 uploads.
 *                      R2 env vars are not required in this mode.
 *   --limit=N          Only process the first N messages (useful for testing).
 *                      e.g. --limit=3
 *   --category=VALUE   Override the category for all processed messages.
 *                      Values: sermon | seminar | auto (default: auto)
 *                      'auto' detects based on the series name (see SEMINAR_SERIES below).
 *
 * Required env vars (not needed for --dry-run):
 *   R2_ACCESS_KEY_ID       - Cloudflare R2 access key
 *   R2_SECRET_ACCESS_KEY   - Cloudflare R2 secret key
 *   R2_ACCOUNT_ID          - Cloudflare account ID (from R2 dashboard URL)
 *   R2_BUCKET              - R2 bucket name (e.g. "rolleston-sermons")
 *   R2_PUBLIC_URL          - Public base URL for the bucket (e.g. "https://sermons.example.com")
 *
 * Install deps first:
 *   npm install cheerio @aws-sdk/client-s3
 */

import { writeFileSync, existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseBuffer } from "music-metadata";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import * as cheerio from "cheerio";

// Load scripts/.env automatically if it exists
const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(__dirname, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// ─── CLI flags ───────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const DISCOVER = process.argv.includes("--discover");
const LIST_SERIES = process.argv.includes("--list-series");
const VERIFY = process.argv.includes("--verify");
const FIX_METADATA = process.argv.includes("--fix-metadata");
const UPLOAD_ALL = process.argv.includes("--upload-all");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const categoryArg = process.argv.find((a) => a.startsWith("--category="));
const CATEGORY_OVERRIDE = categoryArg
  ? categoryArg.split("=")[1].toLowerCase()
  : "auto";
const seriesArg = process.argv.find((a) => a.startsWith("--series="));
let SERIES_FILTER = seriesArg ? seriesArg.slice(9).replace(/^"|"$/g, "") : null;

if (DRY_RUN)
  console.log("[DRY RUN] No files will be downloaded or uploaded.\n");
if (DISCOVER) console.log("[DISCOVER] Scraping metadata only — no uploads.\n");
if (LIMIT < Infinity)
  console.log(`[LIMIT] Processing at most ${LIMIT} messages.\n`);
if (CATEGORY_OVERRIDE !== "auto")
  console.log(`[CATEGORY] Forcing all messages to: ${CATEGORY_OVERRIDE}\n`);
if (SERIES_FILTER) console.log(`[SERIES] Only uploading: "${SERIES_FILTER}"\n`);

// ─── Config ──────────────────────────────────────────────────────────────────

const SITEMAP_URL =
  "https://www.rollestonbaptist.org.nz/wp-sitemap-posts-enmse_message-1.xml";
const BASE_URL = "https://www.rollestonbaptist.org.nz";
const MANIFEST_FILE = "./scripts/sermon-manifest.json";
const OVERRIDES_FILE = "./scripts/audio-overrides.json";

// Manual Drive file ID overrides for pages where the link isn't on the page
// Format: { "https://full-page-url/": "driveFileId" }
const AUDIO_OVERRIDES = existsSync(OVERRIDES_FILE)
  ? JSON.parse(readFileSync(OVERRIDES_FILE, "utf-8"))
  : {};

// ─── Category detection ──────────────────────────────────────────────────────
//
// Series Engine on this site has two instances: Sermons and Seminars.
// Individual message pages don't expose which instance they belong to,
// so we detect based on the series name.
//
// Add series names here as new seminar series are created.
// Any series NOT in this list defaults to "sermon".
// You can also bypass this entirely with --category=sermon or --category=seminar.

const SEMINAR_SERIES = new Set([
  // Topical/doctrinal series (Seminars)
  "1689 Baptist Confession Overview",
  "Ageing to the Glory of God",
  "Biblical Answers to False Beliefs",
  "Camp",
  "2025 Camp - Healthy Church",
  "Delighting in the Father's Love",
  "Doctrines of Grace",
  "Elders and Deacons",
  "Equipping for Life",
  "God's Love",
  "Healthy Church",
  "LBC 1689",
  "Maori Mythologies & Cultural Narratives",
  "Parenting in our Internet-Connected Age",
  "Prayer",
  "Religions of the World",
  "The Doctrine of God's Love",
  "Trinity",
  "Use Technology Wisely",
  "Worldview",
]);

function detectCategory(series) {
  if (CATEGORY_OVERRIDE !== "auto") return CATEGORY_OVERRIDE;
  if (!series) return "sermon";
  // Case-insensitive prefix match so partial names still hit
  for (const s of SEMINAR_SERIES) {
    if (series.toLowerCase().startsWith(s.toLowerCase())) return "seminar";
  }
  return "sermon";
}

// How long to wait between page requests (ms) — be polite to their server
const PAGE_DELAY = 400;
// How long to wait between Google Drive downloads (ms)
const DOWNLOAD_DELAY = 800;
// Max retries for a failed fetch
const MAX_RETRIES = 3;

const {
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_ACCOUNT_ID,
  R2_BUCKET,
  R2_PUBLIC_URL,
} = process.env;

if (
  !DRY_RUN &&
  !DISCOVER &&
  !LIST_SERIES &&
  !VERIFY && !FIX_METADATA && !UPLOAD_ALL &&
  (!R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_ACCOUNT_ID ||
    !R2_BUCKET ||
    !R2_PUBLIC_URL)
) {
  console.error(
    "Missing required env vars. Set: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_BUCKET, R2_PUBLIC_URL\n" +
      "(Or use --dry-run to test scraping without uploading.)",
  );
  process.exit(1);
}

const R2 = DRY_RUN
  ? null
  : new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (compatible; sermon-archiver/1.0; +https://github.com/your-repo)",
    ...options.headers,
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...options, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      const wait = attempt * 1000;
      console.warn(
        `  Retry ${attempt}/${retries} after ${wait}ms: ${err.message}`,
      );
      await sleep(wait);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractGDriveId(href) {
  if (!href) return null;
  // Matches /file/d/FILE_ID/ or /open?id=FILE_ID
  const m =
    href.match(/\/d\/([a-zA-Z0-9_-]{20,})/) ||
    href.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  return m?.[1] ?? null;
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildR2Key(category, series, year, slug) {
  const cat = category === "seminar" ? "seminars" : "sermons";
  const seriesSlug = slugify(series || "standalone");
  return `${cat}/${seriesSlug}/${year}/${slug}.mp3`;
}

async function fileExistsInR2(key) {
  if (DRY_RUN) return false;
  try {
    await R2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

// ─── Sitemap parsing ─────────────────────────────────────────────────────────

async function getAllMessageUrls() {
  console.log("Fetching sitemap...");
  const res = await fetchWithRetry(SITEMAP_URL);
  const xml = await res.text();

  // Extract all <loc> values from the XML
  const urls = [];
  const locRegex = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = locRegex.exec(xml)) !== null) {
    const url = m[1].trim();
    if (url.includes("/messages/")) urls.push(url);
  }

  // Also extract lastmod dates (useful for sorting/display)
  const lastmodRegex = /<lastmod>([^<]+)<\/lastmod>/g;
  const dates = [];
  while ((m = lastmodRegex.exec(xml)) !== null) {
    dates.push(m[1].trim());
  }

  console.log(`Found ${urls.length} message URLs in sitemap.`);
  return urls.map((url, i) => ({ url, sitemapDate: dates[i] ?? null }));
}

// ─── Sermon page scraping ────────────────────────────────────────────────────

function parseSermonPage(html, url) {
  const $ = cheerio.load(html);

  // Title + speaker from <title>: 'Message: "TITLE" from SPEAKER | ...'
  // cheerio decodes HTML entities automatically
  const pageTitle = $("title").first().text();
  // Matches both straight and curly quotes around the title
  const titleMatch = pageTitle.match(
    /Message:\s*[\u201c"](.+?)[\u201d"]\s+from\s+(.+?)\s*[|\u2013-]/,
  );
  const title =
    titleMatch?.[1]?.trim() ??
    pageTitle
      .split("|")[0]
      .replace(/^Message:\s*/i, "")
      .trim();
  const speaker = titleMatch?.[2]?.trim() ?? "";

  // Date from the author/date byline: "by Author on DATE"
  // Also appears as: "Joe Fleener - 22 March, 2026" in a widget
  let date = "";
  const bodyText = $("body").text();
  const dateFromByline = bodyText.match(/\bon\s+(\d{1,2}\s+\w+,\s+\d{4})/);
  if (dateFromByline) {
    date = dateFromByline[1].trim();
  } else {
    // Fallback: "SPEAKER - DATE" pattern
    const dateFromWidget = bodyText.match(/-\s*(\d{1,2}\s+\w+,\s+\d{4})/);
    if (dateFromWidget) date = dateFromWidget[1].trim();
  }

  // Series from "From Series: "NAME"" — the name may be wrapped in <em> tags
  let series = "";
  const seriesEl = $("*")
    .filter((_, el) => {
      return $(el).text().trim().startsWith("From Series:");
    })
    .first();
  if (seriesEl.length) {
    // Get inner text of the element, stripping any tags
    const raw = seriesEl.text().replace("From Series:", "").trim();
    series = raw.replace(/^[\u201c"\u2018']|[\u201d"\u2019']$/g, "").trim();
  } else {
    // Fallback: regex on full text
    const seriesMatch = bodyText.match(
      /From Series:\s*[\u201c"](.+?)[\u201d"]/,
    );
    if (seriesMatch) series = seriesMatch[1].trim();
  }

  // Topics (Related Topics: X | Y | ...)
  let topics = [];
  const topicsMatch = bodyText.match(/Related Topics:\s*([^|]+(?:\|[^|]+)*)/);
  if (topicsMatch) {
    topics = topicsMatch[1]
      .split("|")
      .map((t) => t.trim())
      .filter((t) => t && !t.startsWith("More Messages"));
  }

  // Google Drive link from "Download Audio" anchor
  let driveHref = null;
  $("a[href*='drive.google.com']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      driveHref = href;
      return false; // stop at first
    }
  });

  const fileId = extractGDriveId(driveHref);

  // Derive slug from URL
  const slug = url.replace(/.*\/messages\//, "").replace(/\/$/, "");

  return { url, slug, title, speaker, date, series, topics, fileId, driveHref };
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "0:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ─── Google Drive download + R2 upload ───────────────────────────────────────

async function downloadAndUpload(fileId, r2Key, label) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would download GDrive ID: ${fileId}`);
    console.log(`  [DRY RUN] Would upload to R2 key:   ${r2Key}`);
    return { r2Url: `[dry-run]/${r2Key}`, sizeMB: 0, durationSecs: 0, duration: "0:00:00" };
  }

  if (await fileExistsInR2(r2Key)) {
    const r2Url = `${R2_PUBLIC_URL}/${r2Key}`;
    console.log(`  SKIP (already uploaded): ${r2Key}`);
    return { r2Url, sizeMB: null, durationSecs: null, duration: null };
  }

  // Try direct download URL with confirm=t to bypass virus-scan redirect
  const dlUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

  let res;
  try {
    res = await fetchWithRetry(dlUrl, {
      headers: { Accept: "audio/mpeg, audio/*, */*" },
      redirect: "follow",
    });
  } catch (err) {
    throw new Error(
      `Google Drive download failed for ${fileId}: ${err.message}`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "audio/mpeg";

  // Google sometimes serves HTML (quota exceeded / login required) — detect it
  if (contentType.includes("text/html")) {
    throw new Error(
      `Google Drive returned HTML instead of audio for file ID ${fileId}. ` +
        "The file may be private or quota-exceeded.",
    );
  }

  // Buffer the body (files are 10–30 MB — acceptable in memory)
  const arrayBuffer = await res.arrayBuffer();
  const body = Buffer.from(arrayBuffer);
  const contentLength = body.byteLength;

  // Sanity check: real audio files are at least 500 KB
  if (contentLength < 500 * 1024) {
    throw new Error(
      `Downloaded file is suspiciously small (${(contentLength / 1024).toFixed(1)} KB) for file ID ${fileId}. ` +
        "Likely a quota/auth page slipped through.",
    );
  }

  await R2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: r2Key,
      Body: body,
      ContentType: contentType.includes("audio") ? contentType : "audio/mpeg",
      ContentLength: contentLength,
      Metadata: { "source-label": encodeURIComponent(label) },
    }),
  );

  // Verify the upload actually landed with correct size
  const head = await R2.send(
    new HeadObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }),
  );
  if (head.ContentLength !== contentLength) {
    throw new Error(
      `Upload size mismatch for ${r2Key}: uploaded ${contentLength} bytes but R2 reports ${head.ContentLength}`,
    );
  }

  // Parse audio metadata (duration) from the buffered file
  let durationSecs = 0;
  let duration = "0:00:00";
  try {
    const metadata = await parseBuffer(body, { mimeType: "audio/mpeg" });
    durationSecs = Math.round(metadata.format.duration ?? 0);
    duration = formatDuration(durationSecs);
  } catch {
    console.warn(`  WARN: could not parse duration for ${r2Key}`);
  }

  const r2Url = `${R2_PUBLIC_URL}/${r2Key}`;
  const sizeMB = parseFloat((contentLength / 1024 / 1024).toFixed(1));
  console.log(`  UPLOADED ${sizeMB} MB ${duration}: ${r2Key}`);
  return { r2Url, sizeMB, durationSecs, duration };
}

// ─── R2 verify ───────────────────────────────────────────────────────────────

async function listAllR2Keys() {
  const keys = new Set();
  let token;
  do {
    const res = await R2.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) keys.add(obj.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function verify() {
  if (!existsSync(MANIFEST_FILE)) {
    console.log("No manifest found. Run --discover first.");
    return;
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));

  console.log("Fetching R2 object list...");
  const r2Keys = await listAllR2Keys();
  console.log(`R2 bucket has ${r2Keys.size} objects.\n`);

  const doneEntries = manifest.filter((e) => e.status === "done" && e.r2Key);
  let missingCount = 0;
  let orphanCount = 0;

  // Manifest says done but file is missing from R2
  for (const e of doneEntries) {
    if (!r2Keys.has(e.r2Key)) {
      console.warn(`  MISSING from R2 (resetting to pending): ${e.r2Key}`);
      e.status = "pending";
      e.r2Url = null;
      e.r2Key = null;
      missingCount++;
    }
  }

  // Files in R2 not referenced by any manifest entry
  const manifestKeys = new Set(doneEntries.map((e) => e.r2Key));
  for (const key of r2Keys) {
    if (!manifestKeys.has(key)) {
      console.log(`  ORPHAN in R2 (not in manifest): ${key}`);
      orphanCount++;
    }
  }

  if (missingCount === 0 && orphanCount === 0) {
    console.log(
      `✓ All ${doneEntries.length} done entries confirmed in R2. No orphans.`,
    );
  } else {
    console.log(
      `\nSummary: ${missingCount} missing from R2 (reset to pending), ${orphanCount} orphan(s) in R2.`,
    );
    if (missingCount > 0) {
      writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
      console.log(
        "Manifest updated — run `pnpm sermons:upload` to re-upload missing files.",
      );
    }
    if (orphanCount > 0) {
      console.log(
        "Orphan files can be deleted manually from the R2 dashboard.",
      );
    }
  }
}

// ─── Interactive series picker ───────────────────────────────────────────────

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(question, (ans) => {
      rl.close();
      res(ans.trim());
    }),
  );
}

function buildSeriesSummary(manifest) {
  const counts = {};
  const statuses = {};
  const categories = {};
  for (const e of manifest) {
    const s = e.series || "(no series)";
    counts[s] = (counts[s] ?? 0) + 1;
    if (!statuses[s])
      statuses[s] = { done: 0, pending: 0, skipped: 0, error: 0 };
    const st =
      e.status ?? (e.r2Url ? "done" : e.skipped ? "skipped" : "pending");
    statuses[s][st] = (statuses[s][st] ?? 0) + 1;
    if (!categories[s]) categories[s] = detectCategory(s);
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => ({
      name,
      total,
      category: categories[name],
      ...statuses[name],
    }));
}

async function pickSeries(manifest) {
  const series = buildSeriesSummary(manifest);
  const pending = series.filter(
    (s) => (s.pending ?? 0) > 0 || (s.error ?? 0) > 0,
  );
  const done = series.filter(
    (s) => (s.done ?? 0) > 0 && (s.pending ?? 0) === 0 && (s.error ?? 0) === 0,
  );
  const noAudio = series.filter(
    (s) =>
      (s.done ?? 0) === 0 && (s.pending ?? 0) === 0 && (s.error ?? 0) === 0,
  );

  const W = 80;
  console.log(`\n${"─".repeat(W)}`);
  console.log(
    ` #   ${"Series".padEnd(44)} ${"Cat".padEnd(8)} ${"Total".padStart(5)}  done  pend   err`,
  );
  console.log("─".repeat(W));

  let idx = 1;
  const indexMap = {};

  const fmtRow = (s, num) => {
    const cat = s.category === "seminar" ? "seminar" : "sermon ";
    return ` ${String(num).padStart(2)}. ${s.name.slice(0, 44).padEnd(44)} ${cat.padEnd(8)} ${String(s.total).padStart(5)}  ${String(s.done ?? 0).padStart(4)}  ${String(s.pending ?? 0).padStart(4)}  ${String(s.error ?? 0).padStart(4)}`;
  };

  if (pending.length) {
    console.log(" Pending upload:");
    for (const s of pending) {
      console.log(fmtRow(s, idx));
      indexMap[idx++] = s.name;
    }
  }
  if (done.length) {
    console.log(` Already done (${done.length} series):`);
    for (const s of done) {
      console.log(fmtRow(s, idx));
      indexMap[idx++] = s.name;
    }
  }
  if (noAudio.length) {
    console.log(` No audio / skipped (${noAudio.length} series):`);
    for (const s of noAudio) {
      const cat = s.category === "seminar" ? "seminar" : "sermon ";
      console.log(
        ` --. ${s.name.slice(0, 44).padEnd(44)} ${cat.padEnd(8)} ${String(s.total).padStart(5)}`,
      );
    }
  }

  console.log("─".repeat(W));
  console.log(
    `Total: ${manifest.length} messages across ${series.length} series.\n`,
  );

  const ans = await prompt(
    "Enter number or series name to upload (or 'q' to quit): ",
  );
  if (!ans || ans.toLowerCase() === "q") {
    console.log("Cancelled.");
    process.exit(0);
  }

  const num = parseInt(ans, 10);
  if (!isNaN(num) && indexMap[num]) return indexMap[num];

  const match = series.find((s) =>
    s.name.toLowerCase().includes(ans.toLowerCase()),
  );
  if (match) return match.name;

  console.error(`No series found matching "${ans}".`);
  process.exit(1);
}

// ─── Metadata backfill ───────────────────────────────────────────────────────

async function fixMetadata() {
  if (!existsSync(MANIFEST_FILE)) { console.log("No manifest found."); return; }
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));

  const toFix = manifest.filter((e) => e.status === "done" && e.r2Key && (!e.duration || e.duration === "0:00:00"));
  console.log(`Found ${toFix.length} entries missing duration metadata.\n`);
  if (!toFix.length) { console.log("Nothing to fix."); return; }

  let fixed = 0;
  for (let i = 0; i < toFix.length; i++) {
    const e = toFix[i];
    console.log(`[${i + 1}/${toFix.length}] ${e.r2Key}`);
    try {
      const url = `${R2_PUBLIC_URL}/${e.r2Key}`;
      const res = await fetchWithRetry(url);
      const buf = Buffer.from(await res.arrayBuffer());
      const meta = await parseBuffer(buf, { mimeType: "audio/mpeg" });
      e.durationSecs = Math.round(meta.format.duration ?? 0);
      e.duration = formatDuration(e.durationSecs);
      e.sizeMB = parseFloat((buf.byteLength / 1024 / 1024).toFixed(1));
      console.log(`  → ${e.duration}  ${e.sizeMB} MB`);
      fixed++;
    } catch (err) {
      console.warn(`  WARN: ${err.message}`);
    }
    await sleep(300);
  }

  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  console.log(`\nUpdated ${fixed}/${toFix.length} entries.`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

//   "pending"  — discovered (metadata scraped) but not yet uploaded
//   "pending"  — discovered (metadata scraped) but not yet uploaded
//   "done"     — uploaded successfully
//   "skipped"  — no audio link found on the page
//   "error"    — upload or scrape failed (will be retried on next run)

async function run() {
  // ── --verify: cross-check manifest against live R2 bucket ──────────────────
  if (VERIFY) { await verify(); return; }

  // ── --fix-metadata: backfill duration/size for already-uploaded entries ─────
  if (FIX_METADATA) { await fixMetadata(); return; }

  // ── interactive picker: shown for --list-series or when run with no flags ──
  const noActionFlags = !DISCOVER && !DRY_RUN && !SERIES_FILTER && !UPLOAD_ALL;
  if (LIST_SERIES || noActionFlags) {
    if (!existsSync(MANIFEST_FILE)) {
      console.log("No manifest found. Run --discover first.");
      return;
    }
    const mForPick = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));
    const chosen = await pickSeries(mForPick);
    console.log(`\n[SERIES] Uploading: "${chosen}"\n`);
    SERIES_FILTER = chosen;
  }

  // ── Load existing manifest ─────────────────────────────────────────────────
  let manifest = [];
  const manifestByUrl = new Map();
  if (existsSync(MANIFEST_FILE)) {
    manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));
    manifest.forEach((e) => manifestByUrl.set(e.url, e));
    console.log(`Manifest loaded: ${manifest.length} entries.`);
  }

  const entries = await getAllMessageUrls();

  // ── Determine which entries to process ────────────────────────────────────
  let toProcess;
  if (DISCOVER) {
    // Discover: only fetch pages we haven't seen before
    toProcess = entries.filter((e) => !manifestByUrl.has(e.url));
  } else {
    // Upload: process pending/error entries (optionally filtered by series)
    toProcess = entries.filter((e) => {
      const existing = manifestByUrl.get(e.url);
      if (!existing) return true; // not yet seen at all
      const status =
        existing.status ??
        (existing.r2Url ? "done" : existing.skipped ? "skipped" : "pending");
      if (status === "done" || status === "skipped") return false;
      // If --series filter active, only include matching series
      if (SERIES_FILTER && existing.series !== SERIES_FILTER) return false;
      return true;
    });
    // Only apply series filter to not-yet-discovered entries too
    if (SERIES_FILTER) {
      toProcess = toProcess.filter((e) => {
        const existing = manifestByUrl.get(e.url);
        return !existing || existing.series === SERIES_FILTER;
      });
    }
  }

  if (LIMIT < Infinity) toProcess = toProcess.slice(0, LIMIT);
  const doneCount = manifest.filter(
    (e) => (e.status ?? "") === "done" || e.r2Url,
  ).length;
  console.log(
    `${toProcess.length} messages to process. (${doneCount} already done, ${manifest.length} total in manifest)\n`,
  );

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  const errorLog = [];

  for (let i = 0; i < toProcess.length; i++) {
    const { url, sitemapDate } = toProcess[i];
    console.log(`[${i + 1}/${toProcess.length}] ${url}`);

    // Scrape page if not already in manifest, or if status is error
    let pageData;
    const existing = manifestByUrl.get(url);
    if (existing && existing.title) {
      pageData = existing;
    } else {
      try {
        const res = await fetchWithRetry(url);
        const html = await res.text();
        pageData = parseSermonPage(html, url);
      } catch (err) {
        console.error(`  ERROR scraping page: ${err.message}`);
        const entry = {
          url,
          sitemapDate,
          status: "error",
          error: `page scrape: ${err.message}`,
        };
        upsertManifest(manifest, manifestByUrl, entry);
        errorCount++;
        saveManifest(manifest);
        await sleep(PAGE_DELAY);
        continue;
      }
    }

    const category = detectCategory(pageData.series);
    console.log(
      `  "${pageData.title}" — ${pageData.speaker} — ${pageData.date} — Series: ${pageData.series || "(none)"} [${category}]`,
    );

    if (!pageData.fileId) {
      // Check manual overrides before giving up
      const overrideId =
        AUDIO_OVERRIDES[url] ??
        AUDIO_OVERRIDES[url.replace(/\/$/, "") + "/"] ??
        AUDIO_OVERRIDES[url.replace(/\/$/, "")];
      if (overrideId) {
        console.log(`  OVERRIDE: using manual Drive ID: ${overrideId}`);
        pageData.fileId = overrideId;
      } else {
        console.warn(`  NO AUDIO LINK found — skipping`);
        const entry = {
          ...pageData,
          sitemapDate,
          category,
          r2Url: null,
          status: "skipped",
        };
        upsertManifest(manifest, manifestByUrl, entry);
        skipCount++;
        saveManifest(manifest);
        await sleep(PAGE_DELAY);
        continue;
      }
    }

    // In discover mode, just save metadata and move on
    if (DISCOVER || DRY_RUN) {
      if (DISCOVER) console.log(`  DISCOVERED (pending upload)`);
      if (DRY_RUN) {
        const year = pageData.date.match(/\d{4}/)?.[0] ?? "unknown";
        const r2Key = buildR2Key(
          category,
          pageData.series,
          year,
          pageData.slug,
        );
        console.log(`  [DRY RUN] Would upload to R2: ${r2Key}`);
      }
      const entry = {
        ...pageData,
        sitemapDate,
        category,
        r2Url: null,
        status: "pending",
      };
      upsertManifest(manifest, manifestByUrl, entry);
      successCount++;
      saveManifest(manifest);
      await sleep(PAGE_DELAY);
      continue;
    }

    // R2 key: {sermons|seminars}/{series-slug}/{year}/{slug}.mp3
    const year = pageData.date.match(/\d{4}/)?.[0] ?? "unknown";
    const r2Key = buildR2Key(category, pageData.series, year, pageData.slug);

    let r2Url = null;
    let sizeMB = null;
    let durationSecs = null;
    let duration = null;
    try {
      await sleep(DOWNLOAD_DELAY);
      ({ r2Url, sizeMB, durationSecs, duration } = await downloadAndUpload(pageData.fileId, r2Key, pageData.title));
      successCount++;
    } catch (err) {
      console.error(`  ERROR uploading: ${err.message}`);
      const entry = {
        ...pageData,
        sitemapDate,
        category,
        r2Url: null,
        status: "error",
        error: `upload: ${err.message}`,
      };
      upsertManifest(manifest, manifestByUrl, entry);
      errorLog.push({ title: pageData.title, url, error: err.message });
      errorCount++;
      saveManifest(manifest);
      await sleep(PAGE_DELAY);
      continue;
    }

    const entry = {
      ...pageData,
      sitemapDate,
      category,
      r2Url,
      r2Key,
      sizeMB,
      durationSecs,
      duration,
      status: "done",
    };
    upsertManifest(manifest, manifestByUrl, entry);
    saveManifest(manifest);
    await sleep(PAGE_DELAY);
  }

  const label = DISCOVER ? "Discovered" : "Uploaded";
  console.log(`\n─── Done ───────────────────────────────────────────`);
  console.log(`  ${label}: ${successCount}`);
  console.log(`  Skipped (no audio): ${skipCount}`);
  console.log(`  Errors: ${errorCount}`);
  if (errorLog.length) {
    console.log(`\n  Failed files:`);
    for (const e of errorLog) {
      console.log(`    ✗ ${e.title}`);
      console.log(`      ${e.url}`);
      console.log(`      ${e.error}`);
    }
  }
  console.log(`  Manifest: ${MANIFEST_FILE}`);
  console.log(`  Total entries: ${manifest.length}`);
  if (DISCOVER)
    console.log(`\nNext step: node scripts/scrape-sermons.mjs --list-series`);
}

function saveManifest(manifest) {
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

// Upsert: update existing entry by URL or append new one
function upsertManifest(manifest, manifestByUrl, entry) {
  const existing = manifestByUrl.get(entry.url);
  if (existing) {
    const idx = manifest.indexOf(existing);
    manifest[idx] = entry;
    manifestByUrl.set(entry.url, entry);
  } else {
    manifest.push(entry);
    manifestByUrl.set(entry.url, entry);
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
