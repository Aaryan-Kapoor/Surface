#!/usr/bin/env python3
"""Original score for the Surface launch video (surface-banner.mp4, 66.5s).

Synthesized from scratch with numpy — no samples, no external audio.
Every hit is timed to the GSAP timeline in index.html:

  0.00–6.4   S1  prompt         airy intro pad, soft pluck on send (4.47)
  6.4–13.7   S2  markdown wall  minor third enters, uneasy heartbeat
  13.7–25.9  S3  HTML era       dead-click thuds (17.97, 19.07),
                                verdict-stamp slams (21.5 … 23.24)
  26.2–28.45 S4  riser          noise/pitch riser, hard cut to silence
  28.45      S4  "Surface"      impact: sub drop, chord flips minor→major
  32.6–57.8  S5  Surface era    100 BPM pulse, bells on every agent↔surface
                                pulse arrival, ascending ladder on the tiles
  57.8       S5  warm takeover  shift to Fmaj9 warmth + shimmer
  61.8–66.5  S6  close          final Cmaj-add9 swell, decay to silence

Output: score.wav (48 kHz stereo).  Mux with:
  ffmpeg -i surface-banner.mp4 -i score.wav -c:v copy -c:a aac -b:a 192k \
         -movflags +faststart -shortest surface-launch.mp4
"""

import numpy as np
import wave

SR = 48000
DUR = 66.5
N = int(SR * DUR)
rng = np.random.default_rng(66)

L = np.zeros(N)
R = np.zeros(N)


def add(sig, t0, pan=0.0, gain=1.0):
    """Mix sig into the stereo bus at time t0 with constant-power pan."""
    i0 = int(t0 * SR)
    if i0 >= N:
        return
    seg = sig[: N - i0] * gain
    th = (pan + 1.0) * np.pi / 4.0
    L[i0 : i0 + len(seg)] += seg * np.cos(th)
    R[i0 : i0 + len(seg)] += seg * np.sin(th)


def env(n, points):
    """Breakpoint envelope over n samples; points = [(t_sec, level), ...]."""
    t = np.arange(n) / SR
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return np.interp(t, xs, ys)


# ── instruments ──────────────────────────────────────────────────────

def pad_note(freq, dur, k=2.2, att=1.5, rel=2.5, detune=0.0018, lfo_phase=0.0):
    """One detuned additive pad voice: harmonics with 1/h^k rolloff."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    f = freq * (1.0 + detune)
    for h in range(1, 7):
        if f * h > 15000:
            break
        out += (h ** -k) * np.sin(2 * np.pi * f * h * t + h * 0.7)
    out *= 1.0 + 0.08 * np.sin(2 * np.pi * 0.13 * t + lfo_phase)
    e = np.interp(t, [0, att, max(att, dur - rel), dur], [0, 1, 1, 0])
    return out * e


def pad(t0, dur, freqs, amp, k=2.2, att=1.5, rel=2.5):
    """A pad chord: two detuned voices per note, panned left/right."""
    for i, f in enumerate(freqs):
        ph = i * 1.3
        v = pad_note(f, dur, k, att, rel, +0.0018, ph)
        add(v, t0, pan=-0.38, gain=amp / len(freqs))
        v = pad_note(f, dur, k, att, rel, -0.0018, ph + 2.1)
        add(v, t0, pan=+0.38, gain=amp / len(freqs))


def bell(t0, freq, amp, tau=0.35, pan=0.0):
    """Small bell: fundamental + inharmonic partials, exponential decay."""
    dur = tau * 5
    n = int(dur * SR)
    t = np.arange(n) / SR
    a = np.minimum(t / 0.003, 1.0)  # 3ms attack, no click
    s = np.sin(2 * np.pi * freq * t) * np.exp(-t / tau)
    s += 0.35 * np.sin(2 * np.pi * freq * 2.02 * t) * np.exp(-t / (tau * 0.55))
    s += 0.14 * np.sin(2 * np.pi * freq * 3.93 * t) * np.exp(-t / (tau * 0.3))
    add(s * a, t0, pan=pan, gain=amp)


def thump(t0, amp, f0=90.0, f1=42.0, tau=0.22, click=0.25, pan=0.0):
    """Pitched drum thump: downward sine glide + tiny noise click."""
    dur = tau * 6
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.045)
    phase = 2 * np.pi * np.cumsum(f) / SR
    s = np.sin(phase) * np.exp(-t / tau)
    nz = rng.standard_normal(n) * np.exp(-t / 0.008) * click
    add((s + nz) * np.minimum(t / 0.002, 1.0), t0, pan=pan, gain=amp)


def tick(t0, amp, pan=0.0, tau=0.02):
    """Hi-hat-ish tick: differentiated noise burst."""
    n = int(tau * 8 * SR)
    t = np.arange(n) / SR
    nz = np.diff(rng.standard_normal(n + 1))
    add(nz * np.exp(-t / tau), t0, pan=pan, gain=amp)


# ── note table ───────────────────────────────────────────────────────
C1, C2, G2 = 32.70, 65.41, 98.00
C3, Eb3, E3, F3, G3, Ab3, A3, Bb3 = 130.81, 155.56, 164.81, 174.61, 196.00, 207.65, 220.00, 233.08
C4, D4, E4, F4, G4, A4 = 261.63, 293.66, 329.63, 349.23, 392.00, 440.00
C5, E5, F5, G5, A5 = 523.25, 659.26, 698.46, 783.99, 880.00
C6, D6, E6 = 1046.50, 1174.66, 1318.51

# ── sub drone (present almost throughout, ducked before the drop) ────
n = int(62.0 * SR)
t = np.arange(n) / SR
drone = np.sin(2 * np.pi * C2 * t) + 0.4 * np.sin(2 * np.pi * C1 * t + 0.5)
drone *= 1.0 + 0.1 * np.sin(2 * np.pi * 0.09 * t)
drone *= env(n, [(0, 0), (3, 0.55), (13.7, 0.7), (25.8, 0.7), (26.6, 0.0),
                 (29.0, 0.0), (30.5, 0.8), (57.8, 0.8), (61.0, 0.0)])
add(drone, 0.0, gain=0.16)

# final drone under the close
n = int(4.8 * SR)
t = np.arange(n) / SR
d2 = np.sin(2 * np.pi * C2 * t) + 0.5 * np.sin(2 * np.pi * C1 * t)
d2 *= env(n, [(0, 0), (1.0, 1), (3.4, 1), (4.7, 0)])
add(d2, 61.6, gain=0.20)

# ── pads: the harmonic story ─────────────────────────────────────────
pad(0.5, 6.8, [C3, G3], 0.22, k=2.6)                       # S1  open fifth, no color yet
pad(6.6, 7.6, [C3, Eb3, G3], 0.30, k=2.4)                  # S2  the minor third lands
pad(13.8, 7.7, [C3, Eb3, Ab3], 0.32, k=2.4)                # S3  darker (Ab against C)
pad(21.2, 5.2, [C3, Eb3, G3, Bb3], 0.36, k=2.2, rel=1.8)   # stamps: Cm7 mass
pad(28.45, 5.6, [C3, E3, G3, C4], 0.62, k=1.6, att=0.07)   # THE DROP: minor → major
pad(33.4, 7.2, [C3, G3, D4, E4], 0.36, k=1.8)              # S5  Cmaj9 groove
pad(40.0, 7.2, [C3, F3, A3, E4], 0.36, k=1.8)              #     Fmaj9/C
pad(46.6, 7.2, [C3, G3, E4, D4], 0.36, k=1.8)              #     Cmaj9
pad(53.0, 5.6, [C3, G3, E4, A4], 0.34, k=1.8)              #     Cmaj-add13 lift
pad(57.8, 4.6, [F3, A3, C4, E4], 0.46, k=1.5, att=1.1)     # warm takeover: Fmaj9 glow
pad(61.8, 4.7, [C3, G3, C4, E4, D4], 0.60, k=1.7,          # S6  final Cmaj-add9 swell
    att=1.3, rel=2.9)

# ── S1: the send click (4.47) ────────────────────────────────────────
bell(4.47, C4, 0.10, tau=0.25)

# ── S2/S3: uneasy heartbeat ──────────────────────────────────────────
for i, tt in enumerate(np.arange(8.0, 25.3, 1.45)):
    thump(tt, 0.15 + 0.003 * i, f0=70, f1=38, tau=0.16, click=0.06)

# dead re-run clicks: dull, no ring — nothing answers (17.97, 19.07)
thump(17.97, 0.24, f0=65, f1=40, tau=0.09, click=0.35)
thump(19.07, 0.24, f0=60, f1=38, tau=0.09, click=0.35)

# verdict stamps sweep in: four rising slams (21.5 + 0.58k)
for i, tt in enumerate([21.5, 22.08, 22.66, 23.24]):
    thump(tt, 0.26 + 0.06 * i, f0=110, f1=44, tau=0.26, click=0.5,
          pan=(-0.2 if i % 2 == 0 else 0.2))
    tick(tt + 0.01, 0.10 + 0.03 * i, tau=0.05)

# ── S4: riser into the drop (26.2 → 28.42) ───────────────────────────
n = int(2.25 * SR)
t = np.arange(n) / SR
white = rng.standard_normal(n)
bright = np.append(np.diff(white), 0.0)
b = (t / t[-1]) ** 2                                   # brightness opens up
nz = (1 - b) * white * 0.4 + b * bright * 1.4
nz *= env(n, [(0, 0.0), (1.9, 0.9), (2.0, 1.0), (2.13, 0.0), (2.25, 0)])
add(nz, 26.2, gain=0.22)
f = C4 * (2 ** (2.0 * (t / t[-1]) ** 1.6))             # C4 → C6 sweep
phase = 2 * np.pi * np.cumsum(f) / SR
sw = np.sin(phase) * env(n, [(0, 0), (1.6, 0.7), (2.05, 0.9), (2.15, 0)])
add(sw, 26.2, gain=0.07)

# ── the impact (28.45): sub drop + splash ────────────────────────────
n = int(2.6 * SR)
t = np.arange(n) / SR
f = 34 + (115 - 34) * np.exp(-t / 0.10)
phase = 2 * np.pi * np.cumsum(f) / SR
boom = np.sin(phase) * np.exp(-t / 0.9) * np.minimum(t / 0.002, 1.0)
add(boom, 28.45, gain=0.60)
n = int(0.7 * SR)
t = np.arange(n) / SR
splash = rng.standard_normal(n) * np.exp(-t / 0.16)
add(splash, 28.45, gain=0.10)

# ── S5: the groove ───────────────────────────────────────────────────
# board blooms out of the flash (35.8)
bell(35.8, C5, 0.16, tau=0.5)
thump(35.85, 0.20, f0=85, f1=42, tau=0.2, click=0.1)
# agent dot is born (37.35)
bell(37.35, E6, 0.10, tau=0.4, pan=0.3)

# steady pulse, 100 BPM (0.6s), from the board to the takeover
for i, tt in enumerate(np.arange(36.0, 60.7, 0.6)):
    g = 0.19 + 0.05 * min(i / 8.0, 1.0)
    if tt > 57.8:                                      # ease out under the warm beat
        g *= max(0.0, 1.0 - (tt - 57.8) / 3.0)
    thump(tt, g, f0=72, f1=40, tau=0.14, click=0.08)
# light offbeat ticks
for i, tt in enumerate(np.arange(40.0, 57.5, 0.3)):
    g = 0.045 if i % 2 == 0 else 0.028
    tick(tt, g, pan=(0.35 if i % 2 == 0 else -0.35))

# bells on every agent↔surface pulse arrival
bell(38.75, G5, 0.12, pan=-0.3)    # pl1 lands → test 1 green
bell(40.25, A5, 0.12, pan=0.3)     # pl2 lands → test 2 green
bell(45.00, E5, 0.10, pan=-0.3)    # you send the edge case up
bell(45.55, G5, 0.13, pan=0.3)     # the agent flares
bell(45.62, C6, 0.09, pan=0.3)
bell(47.75, C6, 0.12, pan=-0.3)    # pl4 lands → test 3 green
bell(49.45, D6, 0.12, pan=0.3)     # pl5 lands → your test green
bell(50.05, G5, 0.09, tau=0.6)     # suite complete

# the grid: ripple → answer, an ascending ladder across four tiles
for i, (t_rip, t_ans, f_rip, f_ans) in enumerate([
    (52.9, 53.6, E5, G5),          # /diagnose
    (54.05, 54.75, G5, A5),        # /prototype
    (55.2, 55.9, A5, C6),          # /triage
    (56.35, 57.05, C6, E6),        # /teach
]):
    p = -0.45 + 0.3 * i
    tick(t_rip, 0.07, pan=p, tau=0.03)
    bell(t_rip, f_rip, 0.07, tau=0.22, pan=p)
    bell(t_ans, f_ans, 0.11, tau=0.35, pan=p)

# ── warm takeover (57.8): shimmer drifts in ──────────────────────────
for i, (tt, f) in enumerate([(57.9, F5), (58.25, A5), (58.6, C6), (58.95, E6)]):
    bell(tt, f, 0.065, tau=1.4, pan=-0.4 + 0.27 * i)

# ── S6: close (61.8) ─────────────────────────────────────────────────
bell(61.85, C6, 0.09, tau=1.2)
bell(61.85, G5, 0.07, tau=1.4, pan=-0.25)
thump(61.8, 0.26, f0=80, f1=36, tau=0.5, click=0.05)

# ── master ───────────────────────────────────────────────────────────
master = env(N, [(0, 0), (1.0, 1), (28.18, 1), (28.26, 0.10),   # cut before the drop
                 (28.43, 0.10), (28.47, 1), (65.3, 1), (66.3, 0), (DUR, 0)])
L *= master
R *= master

mix = np.stack([L, R])
mix = np.tanh(1.35 * mix)                # gentle glue/limit
mix *= 0.94 / np.max(np.abs(mix))

pcm = (mix.T * 32767).astype(np.int16)
with wave.open("score.wav", "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())

# quick structural sanity print: RMS per second
rms = [float(np.sqrt(np.mean(mix[:, i * SR : (i + 1) * SR] ** 2))) for i in range(int(DUR))]
for i, v in enumerate(rms):
    print(f"{i:3d}s  {'#' * int(v * 120)}  {v:.3f}")
print(f"\nwrote score.wav  ({DUR}s, 48kHz stereo, peak {np.max(np.abs(mix)):.2f})")
