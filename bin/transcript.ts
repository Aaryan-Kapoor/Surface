// Timestamped captions for a YouTube video.
//
// The `video` surface reports *which video and which second*. This is the other
// half — turning that second into the words that were said — and it exists as a
// built-in because the alternative was telling every agent to install `yt-dlp`,
// which most machines (including a fresh Surface install) do not have.
//
// It fetches through InnerTube's player endpoint rather than the watch page.
// That is not a stylistic choice: the caption URL scraped out of the watch page
// is signed in a way that now returns **HTTP 200 with a zero-byte body**, which
// is the worst possible failure — an agent that checks the status code believes
// it succeeded and then answers from nothing. The mobile client contexts still
// hand back a URL that serves. The web ones do not (they answer UNPLAYABLE),
// so the client list here is load-bearing, not incidental.
//
// This is a moving target: YouTube closes these routes one at a time, which is
// why `yt-dlp` exists and updates constantly. Hence the fallback, and hence the
// rule that this module never reports success without lines to show for it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Cue { t: number; text: string }
export interface TranscriptResult {
  video_id: string;
  language: string;
  generated: boolean;
  /** Set when YouTube machine-translated this from another language. */
  translated_from: string | null;
  source: "innertube" | "yt-dlp";
  duration: number | null;
  cues: Cue[];
}

const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

// Order matters. The mobile contexts are the ones still served; WEB and MWEB
// answer UNPLAYABLE for a signed-out caller, and TVHTML5 errors outright.
const CLIENTS = [
  { clientName: "IOS", clientVersion: "20.10.4", deviceModel: "iPhone16,2" },
  { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30 },
];

export function videoIdOf(input: string): string | null {
  const raw = String(input || "").trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.hostname === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (!u.hostname.endsWith("youtube.com")) return null;
  if (u.pathname === "/watch") {
    const v = u.searchParams.get("v");
    return v && /^[\w-]{11}$/.test(v) ? v : null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  if (["embed", "shorts", "live", "v"].includes(parts[0]) && /^[\w-]{11}$/.test(parts[1] || "")) {
    return parts[1];
  }
  return null;
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  isTranslatable?: boolean;
  name?: unknown;
}

/**
 * Pick the track to read.
 *
 * A human-written track beats a machine-written one every time — auto-captions
 * have no punctuation to speak of and mangle names — so `kind !== "asr"` wins
 * within the requested language before falling back to the ASR track.
 */
export function pickTrack(
  tracks: CaptionTrack[],
  lang: string,
): { track: CaptionTrack; translateTo: string | null } | null {
  if (!tracks.length) return null;
  const inLang = tracks.filter((t) => (t.languageCode || "").toLowerCase().startsWith(lang.toLowerCase()));
  if (inLang.length) {
    return { track: inLang.find((t) => t.kind !== "asr") ?? inLang[0], translateTo: null };
  }
  // No track in the language asked for. Falling back to whatever happened to be
  // first is how you hand back English captions labelled as Spanish, so instead
  // ask YouTube to translate one — and record that it did, because a machine
  // translation of a machine transcription is two lossy steps and a quote taken
  // from it should be hedged accordingly.
  const source = tracks.find((t) => t.kind !== "asr" && t.isTranslatable) ?? tracks.find((t) => t.isTranslatable);
  return source ? { track: source, translateTo: lang } : null;
}

/**
 * Parse YouTube's json3 caption format.
 *
 * Events carrying `aAppend` are the rolling-window continuations — they hold a
 * bare newline and re-state text already emitted. Dropping them yields clean,
 * non-overlapping cues with no deduplication heuristic at all. (Measured on a
 * 22-minute video: 1347 events in, 674 cues out, zero repeats. The same video's
 * WebVTT, parsed naively, gives 2018 lines of which 1344 are repeats — which is
 * why this reads json3 and not vtt.)
 */
export function parseJson3(body: string): Cue[] {
  const doc = JSON.parse(body);
  const out: Cue[] = [];
  for (const ev of doc.events ?? []) {
    if (!ev || !Array.isArray(ev.segs) || ev.aAppend) continue;
    const text = ev.segs.map((s: { utf8?: string }) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    // Floor, not round: a cue starting at 1520ms was already being spoken during
    // second 1, so rounding it up to 2 both attributes the words later than they
    // were said and hides them from a query about second 1. Erring early keeps
    // the start of a phrase inside the window that asks for it.
    out.push({ t: Math.floor((ev.tStartMs ?? 0) / 1000), text });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Why we came back empty-handed.
 *
 * This exists so the command cannot tell the user something false. Every
 * failure here looks identical from the call site — no transcript — but
 * "this video has captions disabled" and "you have been asked to slow down"
 * lead to opposite next moves, and an agent that repeats the wrong one sounds
 * authoritative while being wrong.
 */
type Blocked = "rate-limited" | "unplayable" | "no-captions" | "empty-body" | "network";
let lastBlock: Blocked = "network";
/** Languages the video did offer, so "not in that language" can name the alternatives. */
let offered: string[] = [];

/** Fetch with one backoff retry, but only for the throttle case. */
async function fetchOnce(url: string, init?: RequestInit): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, headers: { "User-Agent": "Mozilla/5.0", ...(init?.headers ?? {}) } });
    } catch {
      lastBlock = "network";
      return null;
    }
    if (res.status === 429) {
      lastBlock = "rate-limited";
      if (attempt === 0) { await sleep(1500); continue; }
      return null;
    }
    if (!res.ok) { lastBlock = "network"; return null; }
    return res;
  }
  return null;
}

async function viaInnerTube(videoId: string, lang: string): Promise<TranscriptResult | null> {
  for (const client of CLIENTS) {
    const res = await fetchOnce(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: { client }, videoId }),
    });
    if (!res) continue;
    let player: any;
    try { player = await res.json(); } catch { continue; }

    if (player?.playabilityStatus?.status !== "OK") { lastBlock = "unplayable"; continue; }
    const tracks: CaptionTrack[] =
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const picked = pickTrack(tracks, lang);
    if (!picked?.track?.baseUrl) {
      lastBlock = "no-captions";
      offered = tracks.map((t) => t.languageCode).filter(Boolean);
      continue;
    }
    const { track, translateTo } = picked;

    const capRes = await fetchOnce(
      `${track.baseUrl}&fmt=json3${translateTo ? `&tlang=${encodeURIComponent(translateTo)}` : ""}`,
    );
    if (!capRes) continue;
    const body = await capRes.text();
    // The empty-200 case. Never mistake it for an empty transcript.
    if (!body.trim()) { lastBlock = "empty-body"; continue; }

    let cues: Cue[];
    try { cues = parseJson3(body); } catch { lastBlock = "empty-body"; continue; }
    if (!cues.length) { lastBlock = "empty-body"; continue; }

    const seconds = Number(player?.videoDetails?.lengthSeconds);
    return {
      video_id: videoId,
      language: translateTo || track.languageCode || lang,
      translated_from: translateTo ? (track.languageCode || null) : null,
      generated: track.kind === "asr",
      source: "innertube",
      duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      cues,
    };
  }
  return null;
}

function haveYtDlp(): boolean {
  try {
    execFileSync("yt-dlp", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch { return false; }
}

function viaYtDlp(videoId: string, lang: string): TranscriptResult | null {
  if (!haveYtDlp()) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-cc-"));
  try {
    execFileSync("yt-dlp", [
      "--skip-download", "--no-warnings",
      // Ask for both; yt-dlp prefers the human track when one exists.
      "--write-subs", "--write-auto-subs",
      "--sub-langs", lang, "--sub-format", "json3",
      "-o", path.join(dir, "cc.%(ext)s"),
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { stdio: "ignore", timeout: 120_000 });
    const file = fs.readdirSync(dir).find((f) => f.endsWith(".json3"));
    if (!file) return null;
    const cues = parseJson3(fs.readFileSync(path.join(dir, file), "utf8"));
    if (!cues.length) return null;
    return {
      video_id: videoId,
      language: lang,
      generated: true,
      translated_from: null,
      source: "yt-dlp",
      duration: null,
      cues,
    };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fetch a transcript, or throw with something the caller can act on.
 *
 * Never resolves with an empty cue list: "no captions" and "the route we use
 * stopped working" both have to be visible, because the whole point of this is
 * to stop an agent answering a question about a video from nothing.
 */
export async function fetchTranscript(input: string, lang = "en"): Promise<TranscriptResult> {
  const videoId = videoIdOf(input);
  if (!videoId) throw new Error(`Not a YouTube URL or video id: ${input}`);

  const direct = await viaInnerTube(videoId, lang);
  if (direct) return direct;

  const blocked = lastBlock;
  const fallback = viaYtDlp(videoId, lang);
  if (fallback) return fallback;

  // Say the true reason. These lead to opposite next moves: wait and retry,
  // versus stop asking and tell the user this video has nothing to read.
  const why: Record<Blocked, string> = {
    "rate-limited": `Throttled while fetching captions for ${videoId} (HTTP 429). This is temporary — ` +
      `wait a minute and run it again. Do not conclude the video has no captions.`,
    unplayable: `${videoId} would not play for an anonymous viewer — it may be private, age-gated, ` +
      `members-only, or region-blocked.`,
    "no-captions": offered.length
      ? `${videoId} has no ${lang} captions and none that could be translated. It offers: ` +
        `${offered.join(", ")} — pass --lang with one of those.`
      : `${videoId} has no caption tracks at all.`,
    "empty-body": `Captions for ${videoId} were offered but served empty. The fetch route has ` +
      `probably been closed off; this needs a code change, not a retry.`,
    network: `Could not reach YouTube to fetch captions for ${videoId}.`,
  };
  throw new Error(`${why[blocked]} Do not answer questions about the video without them.`);
}

/** Stitch cues into readable blocks of roughly `seconds` each. */
export function blocks(cues: Cue[], seconds: number): Cue[] {
  if (seconds <= 0) return cues;
  const out: Cue[] = [];
  let start: number | null = null;
  let buf: string[] = [];
  for (const cue of cues) {
    if (start === null) start = cue.t;
    buf.push(cue.text);
    if (cue.t - start >= seconds) {
      out.push({ t: start, text: buf.join(" ") });
      start = null;
      buf = [];
    }
  }
  if (buf.length) out.push({ t: start ?? 0, text: buf.join(" ") });
  return out;
}

/** The blocks overlapping a window around `at` — what you want when answering. */
export function around(list: Cue[], at: number, window: number): Cue[] {
  return list.filter((b) => b.t >= at - window && b.t <= at + window);
}

export function clockText(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const two = (n: number) => (n < 10 ? `0${n}` : String(n));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}
