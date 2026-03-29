/**
 * generate-episodes.mjs
 *
 * Reads scripts/sermon-manifest.json and writes/updates episode .md files
 * in src/content/episode/ for every entry with status "done".
 *
 * Safe to re-run: skips files already up to date (same r2Url).
 * Only writes files for entries that have been uploaded to R2.
 *
 * Usage:
 *   node scripts/generate-episodes.mjs
 *   pnpm sermons:generate
 *
 * Options:
 *   --force    Overwrite all existing .md files even if up to date
 *   --dry-run  Show what would be written without writing anything
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = resolve(__dirname, "sermon-manifest.json");
const OUTPUT_DIR = resolve(__dirname, "../src/content/episode");
const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");

if (DRY_RUN) console.log("[DRY RUN] No files will be written.\n");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse date strings like "22 March, 2026" or "20 December, 2020"
 * Returns an ISO date string "YYYY-MM-DD" for frontmatter pubDate.
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  // Normalise: "22 March, 2026" → "22 March 2026"
  const cleaned = dateStr.replace(",", "").trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0]; // "YYYY-MM-DD"
}

/**
 * Escape a value for YAML frontmatter — wraps in double quotes if needed.
 */
function yamlStr(value) {
  if (!value) return '""';
  // If it contains quotes, colons, or newlines, wrap and escape
  if (/[:"'\n#]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Build the body text for an episode.
 */
function buildBody(entry) {
  const parts = [];
  if (entry.speaker) parts.push(`**Speaker:** ${entry.speaker}`);
  if (entry.series)  parts.push(`**Series:** ${entry.series}`);
  // topics can contain scraper noise — filter to short clean strings only
  const cleanTopics = (entry.topics ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.length < 60 && !t.includes("\n") && !t.toLowerCase().includes("download"));
  if (cleanTopics.length) {
    parts.push(`**Topics:** ${cleanTopics.join(", ")}`);
  }
  return parts.join("\n\n");
}

/**
 * Build the full .md content for a manifest entry.
 */
function buildMarkdown(entry) {
  const pubDate = parseDate(entry.date);
  const size = entry.sizeMB ?? 0;
  const duration = entry.duration ?? "0:00:00";

  const lines = [
    "---",
    `title: ${yamlStr(entry.title)}`,
    `audioUrl: ${entry.r2Url}`,
  ];
  if (pubDate) lines.push(`pubDate: ${pubDate}`);
  lines.push(
    `duration: "${duration}"`,
    `size: ${size}`,
    `explicit: false`,
    `episodeType: full`,
  );
  if (entry.category) lines.push(`category: ${entry.category}`);
  if (entry.series)   lines.push(`series: ${yamlStr(entry.series)}`);
  if (entry.speaker)  lines.push(`speaker: ${yamlStr(entry.speaker)}`);
  lines.push("---", "", buildBody(entry));

  return lines.join("\n") + "\n";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (!existsSync(MANIFEST_FILE)) {
  console.error("No manifest found at scripts/sermon-manifest.json. Run --discover first.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));
const done = manifest.filter((e) => e.status === "done" && e.r2Url && e.slug);

console.log(`Manifest: ${manifest.length} total, ${done.length} done entries.\n`);

if (!DRY_RUN) mkdirSync(OUTPUT_DIR, { recursive: true });

let written = 0;
let skipped = 0;
let errors = 0;
const errorLog = [];

for (const entry of done) {
  const filename = `${entry.slug}.md`;
  const filePath = resolve(OUTPUT_DIR, filename);
  const content = buildMarkdown(entry);

  // Check if existing file is already up to date (same audioUrl and duration)
  if (!FORCE && existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8");
    const duration = entry.duration ?? "0:00:00";
    if (existing.includes(`audioUrl: ${entry.r2Url}`) && existing.includes(`duration: "${duration}"`)) {
      skipped++;
      continue;
    }
  }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would write: src/content/episode/${filename}`);
    written++;
    continue;
  }

  try {
    writeFileSync(filePath, content, "utf-8");
    console.log(`  ✓ ${filename}`);
    written++;
  } catch (err) {
    console.error(`  ✗ ${filename}: ${err.message}`);
    errorLog.push({ filename, error: err.message });
    errors++;
  }
}

console.log(`\n─── Done ───────────────────────────────────────────`);
console.log(`  Written:  ${written}`);
console.log(`  Skipped (up to date): ${skipped}`);
console.log(`  Errors:   ${errors}`);
if (errorLog.length) {
  console.log(`\n  Failed files:`);
  for (const e of errorLog) {
    console.log(`    ✗ ${e.filename}: ${e.error}`);
  }
}
console.log(`\n  Output: src/content/episode/`);
