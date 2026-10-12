"""Synthesises the score and sound effects for the promo, so nothing needs licensing.

usage: python music.py <out.wav> [duration] [eq.json]

Writes 44.1 kHz stereo. The centrepiece is the "desktop track": a full, wide, polished song
that plays on the shared desktop, so the film can show sound arriving with the picture. It
is heard from the race on, and its spectrum goes to eq.json, which drives the player's
visualiser in scenes.html, so what you see on the desktop is what you hear. The cue times
below match the scenes in scenes.html.
"""
import base64
import json
import sys

import numpy as np
import soundfile as sf

SR = 44100
out_path = sys.argv[1]
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 95.5
eq_path = sys.argv[3] if len(sys.argv) > 3 else None
N = int(DUR * SR)
rng = np.random.default_rng(7)

# Scene starts in scenes.html
RACE, NUMBER, APP, TRUST, PIPES, NETWORK, END = 12.2, 24.0, 32.0, 50.0, 54.0, 80.0, 89.2
SPOTLIGHTS = [60.0, 66.2, 73.4]  # the pipes infographic moves its spotlight here

BPM = 96
BEAT = 60 / BPM
BAR = 4 * BEAT
NOTE = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}


def hz(n):
    """'F#4' -> frequency."""
    name, octave = n[:-1], int(n[-1])
    return 440.0 * 2 ** ((NOTE[name] + 12 * (octave + 1) - 69) / 12)


class Bus:
    """A stereo buffer that sounds are placed on."""

    def __init__(self):
        self.x = np.zeros((2, N))

    def add(self, sig, t0, gain=1.0, pan=0.0):
        i0 = int(round(t0 * SR))
        if i0 >= N or i0 < 0:
            return
        if sig.ndim == 1:
            a = (pan + 1) * np.pi / 4
            sig = np.stack([sig * np.cos(a), sig * np.sin(a)]) * np.sqrt(2)
        n = min(sig.shape[1], N - i0)
        self.x[:, i0:i0 + n] += sig[:, :n] * gain


def tvec(dur):
    return np.arange(int(dur * SR)) / SR


def fade(n, a=0.003, r=0.02):
    e = np.ones(n)
    na, nr = min(n, int(a * SR)), min(n, int(r * SR))
    if na:
        e[:na] = np.linspace(0, 1, na)
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr)
    return e


def spectral(x, fn):
    """Zero-phase filter of a whole signal: multiply its spectrum by fn(freqs)."""
    n = x.shape[-1]
    f = np.fft.rfftfreq(n, 1 / SR)
    return np.fft.irfft(np.fft.rfft(x, axis=-1) * fn(f), n, axis=-1)


lowpass = lambda fc, order=2: (lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))
highpass = lambda fc, order=2: (lambda f: 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-3)) ** (2 * order)))


def reverb(x, seconds=2.4, wet=0.25):
    """Convolution with a decaying, darkening stereo noise tail: a smooth hall."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = rng.standard_normal((2, n)) * np.exp(-6.9 * t / seconds)
    ir = spectral(ir, lowpass(6000, 1)) * (1 - np.exp(-t / 0.012))  # soft onset, no early slap
    ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))
    size = 1 << int(np.ceil(np.log2(x.shape[1] + n)))
    wetsig = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[:, : x.shape[1]]
    return x + wet * wetsig


# ---- instruments --------------------------------------------------------------------------------
def epiano(f, dur, vel=1.0):
    """FM electric piano: a warm tone bar, a bell-like tine, and a slow stereo shimmer."""
    t = tvec(dur + 1.2)
    idx = (1.6 * vel + 0.4) * np.exp(-t * 2.5) + 0.25
    body = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * t))
    tine = np.sin(2 * np.pi * f * t + 0.9 * vel * np.exp(-t * 18) * np.sin(2 * np.pi * 14 * f * t))
    amp = np.exp(-t * 0.9) * (0.5 + 0.5 * np.exp(-t * 4))
    rel = np.clip((dur + 0.25 - t) / 0.25, 0, 1)  # damper: let go after the note
    s = (body + 0.35 * tine * np.exp(-t * 3)) * amp * rel * fade(len(t), 0.002, 0.05) * vel
    trem = 0.12 * np.sin(2 * np.pi * 4.2 * t)
    return np.stack([s * (1 + trem), s * (1 - trem)])


def lead(f, dur, vel=1.0):
    """A soft, singing lead: two detuned FM voices spread wide, with a little vibrato."""
    t = tvec(dur + 0.4)
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.clip((t - 0.2) / 0.3, 0, 1)
    out = []
    for det in (-0.0035, 0.0035):
        ph = 2 * np.cumsum(np.pi * f * (1 + det) * vib) / SR
        idx = 1.4 * np.exp(-t * 3) + 0.7
        out.append(np.sin(ph + idx * np.sin(ph)) + 0.3 * np.sin(ph / 2))
    env = np.minimum(1, t / 0.015) * np.exp(-t * 0.6) * np.clip((dur + 0.15 - t) / 0.15, 0, 1)
    return np.stack(out) * env * vel


def bass(f, dur, vel=1.0):
    t = tvec(dur)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)
    s = np.tanh(1.6 * s) * np.exp(-t * 1.2) * fade(len(t), 0.004, 0.03)
    return s * vel


def kick():
    t = tvec(0.45)
    f = 48 + 110 * np.exp(-t * 32)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7)
    clickn = rng.standard_normal(len(t)) * np.exp(-t * 600) * 0.4
    return np.tanh(1.4 * (body + clickn))


def _noise_hit(dur, decay, band):
    x = rng.standard_normal(int(dur * SR)) * np.exp(-tvec(dur) * decay)
    return spectral(x, band) * fade(int(dur * SR), 0.0005, 0.01)


SNARE = _noise_hit(0.35, 18, lambda f: highpass(900)(f) * lowpass(9000)(f))
SNARE = SNARE / np.abs(SNARE).max() + 0.6 * np.sin(2 * np.pi * 190 * tvec(0.35)) * np.exp(-tvec(0.35) * 30)
CLAP = sum(np.pad(_noise_hit(0.25, 30, lambda f: highpass(1200)(f) * lowpass(6000)(f)), (int(d * SR), 0))[: int(0.25 * SR)] for d in (0, 0.011, 0.023))
HAT = _noise_hit(0.06, 70, highpass(8000, 3))
OHAT = _noise_hit(0.35, 9, highpass(7000, 3))
SHAKER = _noise_hit(0.08, 45, lambda f: highpass(5000, 2)(f) * lowpass(12000)(f))
for s in ('SNARE', 'CLAP', 'HAT', 'OHAT', 'SHAKER'):
    globals()[s] = globals()[s] / np.abs(globals()[s]).max()


def pad(f, dur):
    t = tvec(dur)
    s = sum(np.sin(2 * np.pi * f * (1 + d) * t) + 0.25 * np.sin(4 * np.pi * f * (1 + d) * t) for d in (-0.004, 0, 0.0045))
    e = np.minimum(1, t / 1.2) * np.minimum(1, (dur - t) / 1.5)
    return s / 3 * e


# ---- the desktop track --------------------------------------------------------------------------
# An eight-bar loop in D major: Dmaj9, Bm9, Gmaj9, A6sus2, two bars each.
CHORDS = [
    ['D3', 'F#3', 'A3', 'C#4', 'E4'],
    ['B2', 'D3', 'F#3', 'A3', 'C#4'],
    ['G2', 'B2', 'D3', 'F#3', 'A3'],
    ['A2', 'E3', 'F#3', 'B3', 'E4'],
]
ROOTS = ['D2', 'B1', 'G1', 'A1']
# The hook, as (beat in the eight-bar loop, note, beats).
MELODY = [
    (0, 'A4', 1), (1.5, 'F#4', 0.5), (2, 'A4', 0.5), (2.5, 'B4', 1.5), (4, 'A4', 1.5), (6, 'F#4', 0.5), (6.5, 'E4', 1.5),
    (8, 'D5', 1), (9.5, 'C#5', 0.5), (10, 'B4', 1), (11.5, 'A4', 0.5), (12, 'F#4', 2.5),
    (16, 'B4', 1), (17.5, 'A4', 0.5), (18, 'B4', 0.5), (18.5, 'D5', 1.5), (20, 'E5', 1), (21.5, 'D5', 0.5), (22, 'B4', 1.5),
    (24, 'C#5', 1), (25.5, 'E5', 0.5), (26, 'C#5', 0.5), (26.5, 'A4', 1.5), (28, 'E4', 2.5),
]
COMP = [(0, 1.0, 1.2), (1.5, 0.7, 0.4), (2.5, 0.8, 0.9), (3.5, 0.6, 0.4)]  # (beat in bar, velocity, beats)
BASSLINE = [(0, 0, 0.9), (1.5, 12, 0.4), (2, 0, 0.45), (2.5, 0, 0.9), (3.5, 12, 0.4)]  # (beat, semitones up, beats)


def desktop_track():
    keys, ld, bs, drums = Bus(), Bus(), Bus(), Bus()
    beats = int(DUR / BEAT) + 1
    for b in range(beats):
        t = b * BEAT
        bar, beat_in_bar = divmod(b, 4)
        chord = (bar // 2) % 4
        # drums: four to the floor, clap and snare on two and four, sixteenth hats
        drums.add(kick(), t, 0.7)
        if beat_in_bar in (1, 3):
            drums.add(SNARE, t, 0.38)
            drums.add(CLAP, t + 0.004, 0.32, pan=0.1)
        for s in range(4):
            vel = (0.42, 0.18, 0.3, 0.2)[s]
            drums.add(HAT, t + s * BEAT / 4, vel * 0.35, pan=0.35)
        drums.add(OHAT, t + BEAT / 2, 0.16, pan=-0.3)
        drums.add(SHAKER, t + 3 * BEAT / 4, 0.12, pan=-0.55)
        if beat_in_bar == 0:
            for (cb, vel, ln) in COMP:
                for i, n in enumerate(CHORDS[chord]):
                    keys.add(epiano(hz(n), ln * BEAT, vel * (0.9 if i else 1.0)), t + cb * BEAT + i * 0.006, 0.17)
            root = hz(ROOTS[chord])
            for (bb, semi, ln) in BASSLINE:
                bs.add(bass(root * 2 ** (semi / 12), ln * BEAT), t + bb * BEAT, 0.42)
    loop = 32 * BEAT
    k = 0
    while k * loop < DUR:
        for (mb, n, ln) in MELODY:
            ld.add(lead(hz(n), ln * BEAT, 0.9), k * loop + mb * BEAT, 0.22)
        k += 1
    # dotted-eighth ping-pong echo on the lead
    d = int(0.75 * BEAT * SR)
    echo = np.zeros_like(ld.x)
    echo[0, d:] += ld.x[1, :-d] * 0.35
    echo[1, 2 * d:] += ld.x[0, : -2 * d] * 0.22
    ld.x += spectral(echo, lambda f: highpass(300)(f) * lowpass(4500)(f))
    # the kick pumps the keys and lead a little, so the groove breathes
    tt = np.arange(N) / SR
    pump = 1 - 0.32 * np.exp(-((tt % BEAT) / 0.11))
    music = (keys.x + ld.x) * pump
    music = reverb(music, 2.6, 0.32)
    low = spectral(bs.x, lowpass(900))
    drums_x = reverb(drums.x, 1.2, 0.08)
    mix = spectral(music + low + drums_x, highpass(32, 3))
    return np.tanh(mix * 1.1) / 1.1


track = desktop_track()

# ---- the score ----------------------------------------------------------------------------------
score = Bus()


def gain_at(t):
    """How loud the desktop track is in the film: silent until the race, then featured."""
    pts = [(0, 0), (RACE + 0.5, 0), (RACE + 1.6, 0.6), (RACE + 3.0, 1.0), (NUMBER, 1.0), (APP, 0.8), (TRUST - 2.0, 0.65), (TRUST, 0),
           (NETWORK, 0), (NETWORK + 1.2, 0.55), (END - 0.4, 0.55), (END + 0.6, 0)]
    xs, ys = zip(*pts)
    return np.interp(t, xs, ys)


tt = np.arange(N) / SR
score.x += track * gain_at(tt)

# Soft pads under the lag, the security act and the end card.
PADS = [['D3', 'F#3', 'A3', 'C#4'], ['B2', 'D3', 'F#3', 'A3'], ['G2', 'B2', 'D3', 'F#3'], ['A2', 'C#3', 'E3', 'A3']]
for a, b, g in [(0, RACE + 1.5, 0.07), (TRUST - 1.0, NETWORK + 1.0, 0.06)]:
    t = a
    while t < b:
        c = int(t // (2 * BAR)) % 4
        ln = min(2 * BAR + 1.5, b - t + 1.5)
        for n in PADS[c]:
            score.add(pad(hz(n), ln), t, g, pan=0.0)
        t += 2 * BAR
# Low drone and a heartbeat kick under the security act.
d = tvec(NETWORK - TRUST)
score.add(np.sin(2 * np.pi * hz('D1') * d) * np.minimum(1, d / 1.5) * np.minimum(1, (NETWORK - TRUST - d) / 2), TRUST, 0.16)
t = SPOTLIGHTS[0]
while t < NETWORK - 0.1:
    score.add(kick(), t, 0.25)
    t += BEAT
# The end card resolves on D major and rings out.
for n in ['D3', 'F#3', 'A3', 'D4', 'A4']:
    score.add(epiano(hz(n), DUR - END), END + 0.05, 0.11)
score.add(pad(hz('D3'), DUR - END), END, 0.08)
score.add(bass(hz('D1'), 3.0), END, 0.5)

# ---- sound effects ------------------------------------------------------------------------------
def click(f=1800, dur=0.03):
    t = tvec(dur)
    return (np.sin(2 * np.pi * f * t) * 0.6 + rng.standard_normal(len(t)) * 0.3) * np.exp(-t * 160)


def chime():
    t = tvec(1.4)
    return (np.sin(2 * np.pi * 1318.5 * t) + 0.7 * np.sin(2 * np.pi * 1975.5 * t) * (t > 0.09)) * np.exp(-t * 3.5) * 0.5


# Late frames in the lag shot: a low tick on each stale frame update (8 to 12 s).
def vnc_time(x):
    step = 0.2 + 0.12 * abs(np.sin(np.floor(x * 3)))
    return np.floor((x - 0.45) / step) * step


prev = None
for k in range(int(8 * 60), int(12 * 60)):
    x = k / 60
    v = vnc_time(x)
    if prev is not None and v != prev:
        score.add(click(420, 0.04), x, 0.22)
    prev = v
score.add(click(2400, 0.025), 33.8, 0.35)  # cursor click on Connect a Device
score.add(chime(), 38.6, 0.4)  # the desktop opens on the phone
for i, t in enumerate(SPOTLIGHTS):  # the spotlight moves to the next part
    score.add(click(1500 - i * 150, 0.05), t, 0.4)

mix = score.x.T
mix /= max(1e-9, np.abs(mix).max()) / 0.9
sf.write(out_path, mix.astype(np.float32), SR)
print(f"wrote {out_path}: {DUR:.1f} s")

# ---- the visualiser -----------------------------------------------------------------------------
# 48 log-spaced bands from 40 Hz to 14 kHz plus the overall level, 30 times a second, each
# 0-255, as base64. The desktop's player reads it at its own clock.
if eq_path:
    FPS, BANDS, WIN = 30, 48, 4096
    mono = track.mean(axis=0)
    mono = np.pad(mono, (WIN // 2, WIN))
    hop = SR // FPS
    frames = int(DUR * FPS)
    edges = np.geomspace(40, 14000, BANDS + 1)
    freqs = np.fft.rfftfreq(WIN, 1 / SR)
    which = np.digitize(freqs, edges) - 1
    win = np.hanning(WIN)
    spec = np.zeros((frames, BANDS))
    rms = np.zeros(frames)
    for i in range(frames):
        seg = mono[i * hop: i * hop + WIN]
        mag = np.abs(np.fft.rfft(seg * win))
        for b in range(BANDS):
            m = mag[which == b]
            spec[i, b] = m.max() if len(m) else 0
        rms[i] = np.sqrt((seg ** 2).mean())
    db = 20 * np.log10(spec + 1e-9)
    ref = np.percentile(db, 97, axis=0)
    v = np.clip((db - (ref - 36)) / 36, 0, 1) ** 1.6
    lvl = np.clip(rms / max(1e-9, np.percentile(rms, 97)), 0, 1)
    out = np.concatenate([v, lvl[:, None]], axis=1)
    for i in range(1, frames):  # fall back slowly, like a real meter
        out[i] = np.maximum(out[i], out[i - 1] * 0.82)
    data = (out * 255).round().astype(np.uint8)
    with open(eq_path, 'w') as fh:
        json.dump({'fps': FPS, 'bands': BANDS, 'data': base64.b64encode(data.tobytes()).decode()}, fh)
    print(f"wrote {eq_path}: {frames} frames")
