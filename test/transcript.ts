// Caption parsing for `surface video transcript`.
//
// The network path is deliberately not exercised here — it depends on YouTube's
// current appetite for serving signed-out callers, and a test suite that goes
// red because a third party changed a client allowlist teaches nothing. What is
// pinned is everything that turns a response into timestamps, because that is
// where a mistake is invisible: a transcript with smeared offsets still *looks*
// like a transcript, and the agent quoting it sounds confident and is wrong.
import assert from "node:assert/strict";
import { around, blocks, clockText, parseJson3, pickTrack, videoIdOf } from "../bin/transcript.js";

const track = (languageCode: string, kind?: string, isTranslatable = true) =>
  ({ baseUrl: `https://x/${languageCode}`, languageCode, kind, isTranslatable });

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err: any) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

check("every shape of YouTube link resolves to the same id", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=DWcqbPm_Rn4",
    "https://youtu.be/DWcqbPm_Rn4?si=abc&t=195",
    "https://www.youtube.com/shorts/DWcqbPm_Rn4",
    "https://www.youtube.com/embed/DWcqbPm_Rn4?start=195",
    "https://www.youtube.com/live/DWcqbPm_Rn4",
    "DWcqbPm_Rn4",
  ]) assert.equal(videoIdOf(url), "DWcqbPm_Rn4", url);
});

check("anything that is not a YouTube video is refused, not guessed at", () => {
  for (const bad of ["https://example.com/clip.mp4", "https://vimeo.com/12345", "not a url", "", "short"]) {
    assert.equal(videoIdOf(bad), null, bad);
  }
  // A watch URL with no v= is not a video, however much it looks like one.
  assert.equal(videoIdOf("https://www.youtube.com/watch?list=PL123"), null);
});

check("aAppend events are dropped, so cues do not overlap", () => {
  // The real shape: a text event, then a continuation carrying a bare newline.
  // Keeping the continuations is what produces a transcript of roughly double
  // length whose timestamps no longer line up with the video.
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, segs: [{ utf8: "I've been a huge fan and advocate of" }] },
      { tStartMs: 1510, aAppend: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 1520, segs: [{ utf8: "Markdown for as long as I can remember," }] },
      { tStartMs: 3390, aAppend: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 3400, segs: [{ utf8: "even to the point where it hurt my" }] },
    ],
  });
  const cues = parseJson3(body);
  assert.equal(cues.length, 3, "continuations must not become cues");
  assert.deepEqual(cues.map((c) => c.t), [0, 1, 3], "ms must become whole seconds");
  assert.equal(cues[1].text, "Markdown for as long as I can remember,");
});

check("a cue is assembled from all its segments, whitespace normalised", () => {
  const cues = parseJson3(JSON.stringify({
    events: [{ tStartMs: 2000, segs: [{ utf8: "one " }, { utf8: "two\n " }, { utf8: "  three" }] }],
  }));
  assert.deepEqual(cues, [{ t: 2, text: "one two three" }]);
});

check("blank and segment-less events are skipped", () => {
  const cues = parseJson3(JSON.stringify({
    events: [
      { tStartMs: 0, segs: [{ utf8: "   " }] },
      { tStartMs: 1000 },
      { tStartMs: 2000, segs: [{ utf8: "real" }] },
      null,
    ],
  }));
  assert.deepEqual(cues, [{ t: 2, text: "real" }]);
});

check("a response with no events yields no cues rather than throwing", () => {
  assert.deepEqual(parseJson3(JSON.stringify({})), []);
  assert.deepEqual(parseJson3(JSON.stringify({ events: [] })), []);
});

check("cues stitch into blocks stamped with the block's first second", () => {
  const cues = [0, 5, 12, 21, 26, 40].map((t) => ({ t, text: `s${t}` }));
  const out = blocks(cues, 20);
  // A block closes on the first cue at or past the width, so 0..21 is one
  // block: the stamp must be where the block *starts*, not where it broke.
  assert.equal(out[0].t, 0);
  assert.equal(out[0].text, "s0 s5 s12 s21");
  assert.equal(out[1].t, 26, "the next block starts at the next cue, not at 20");
  assert.equal(out[1].text, "s26 s40", "a trailing partial block is not dropped");
});

check("a window returns the passage around a moment, inclusive of both edges", () => {
  const list = [0, 60, 120, 180, 240].map((t) => ({ t, text: `s${t}` }));
  assert.deepEqual(around(list, 120, 60).map((b) => b.t), [60, 120, 180]);
  assert.deepEqual(around(list, 0, 30).map((b) => b.t), [0]);
  // Asking about a moment past the end is not an error, it is just empty.
  assert.deepEqual(around(list, 9999, 10), []);
});

check("a human-written track beats a machine-written one in the same language", () => {
  const picked = pickTrack([track("en", "asr"), track("en")], "en");
  assert.equal(picked!.track.kind, undefined, "the manual track must win");
  assert.equal(picked!.translateTo, null, "a native track is never translated");
});

check("a regional variant satisfies the language asked for", () => {
  assert.equal(pickTrack([track("pt-BR")], "pt")!.track.languageCode, "pt-BR");
});

check("a language the video lacks is translated, not quietly substituted", () => {
  // The bug this replaces: falling back to the first track handed back English
  // captions for a caller that asked for Spanish, with nothing saying so.
  const picked = pickTrack([track("en"), track("de")], "es");
  assert.equal(picked!.translateTo, "es", "it must ask for a translation");
  assert.equal(picked!.track.languageCode, "en", "translated from the first usable source");
});

check("translation prefers a human source over a machine one", () => {
  // Machine-translating a machine transcription is two lossy steps; start from
  // the better text where there is a choice.
  const picked = pickTrack([track("en", "asr"), track("de")], "es");
  assert.equal(picked!.track.languageCode, "de");
});

check("a track that cannot be translated is not pressed into service", () => {
  assert.equal(pickTrack([track("en", undefined, false)], "es"), null);
  assert.equal(pickTrack([], "en"), null);
});

check("timestamps read the way a person would say them", () => {
  assert.equal(clockText(0), "0:00");
  assert.equal(clockText(9), "0:09");
  assert.equal(clockText(195.9), "3:15", "seconds floor, so a quote is never attributed a second early");
  assert.equal(clockText(1326), "22:06");
  assert.equal(clockText(3723), "1:02:03");
  assert.equal(clockText(-5), "0:00");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAILED: ${f}`);
  process.exitCode = 1;
} else {
  console.log("transcript tests passed");
}
