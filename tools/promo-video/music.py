"""Synthesises the score and sound effects for the promo, so nothing needs licensing.

usage: python music.py <out.wav> [duration]
Writes 44.1 kHz stereo. The cue times below match the scenes in scenes.html.
"""
import sys
import numpy as np
import soundfile as sf

SR = 44100
out_path = sys.argv[1]
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 95.5
N = int(DUR * SR)
L = np.zeros(N, dtype=np.float64)
R = np.zeros(N, dtype=np.float64)
rng = np.random.default_rng(7)

# Scene starts in scenes.html
RACE, NUMBER, APP, TRUST, PIPES, NETWORK, END = 12.2, 24.0, 32.0, 50.0, 54.0, 80.0, 89.2
SPOTLIGHTS = [60.0, 66.2, 72.3]  # the pipes infographic moves its spotlight here

BPM = 96
BEAT = 60 / BPM
CHORD = 8 * BEAT  # two bars per chord
NOTE = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}
def hz(name, octave):
    return 440.0 * 2 ** ((NOTE[name] + 12 * (octave + 1) - 69) / 12)

# D major colour: Dmaj7, Bm7, Gmaj7, A
PROG = [
    [('D', 3), ('F#', 3), ('A', 3), ('C#', 4)],
    [('B', 2), ('D', 3), ('F#', 3), ('A', 3)],
    [('G', 2), ('B', 2), ('D', 3), ('F#', 3)],
    [('A', 2), ('C#', 3), ('E', 3), ('A', 3)],
]
ROOTS = [('D', 2), ('B', 1), ('G', 1), ('A', 1)]
def chord_at(t):
    return int(t // CHORD) % 4

def add(sig, t0, gain=1.0, pan=0.0):
    i0 = int(t0 * SR)
    if i0 >= N:
        return
    sig = sig[: N - i0]
    l = np.cos((pan + 1) * np.pi / 4)
    r = np.sin((pan + 1) * np.pi / 4)
    L[i0:i0 + len(sig)] += sig * gain * l * np.sqrt(2)
    R[i0:i0 + len(sig)] += sig * gain * r * np.sqrt(2)

def env(n, a, r):
    e = np.ones(n)
    na, nr = int(a * SR), int(r * SR)
    if na:
        e[:na] = np.linspace(0, 1, na)
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr)
    return e

def pad_note(f, dur, bright=0.3):
    t = np.arange(int(dur * SR)) / SR
    s = np.zeros_like(t)
    for det in (-0.004, 0.0, 0.0045):
        ff = f * (1 + det)
        s += np.sin(2 * np.pi * ff * t) + bright * np.sin(4 * np.pi * ff * t) + bright * 0.35 * np.sin(6 * np.pi * ff * t)
    trem = 1 + 0.08 * np.sin(2 * np.pi * 0.25 * t)
    return s / 3 * trem * env(len(t), 1.2, 1.5)

def pluck(f, dur=0.5, decay=6.0):
    t = np.arange(int(dur * SR)) / SR
    return (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)) * np.exp(-decay * t) * env(len(t), 0.004, 0.02)

def kick():
    t = np.arange(int(0.35 * SR)) / SR
    f = 45 + 75 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)

def hat():
    n = int(0.04 * SR)
    x = rng.standard_normal(n)
    x = np.diff(x, prepend=0)
    return x * np.exp(-np.arange(n) / SR * 90) * 0.5

def click(f=1800, dur=0.03):
    t = np.arange(int(dur * SR)) / SR
    return (np.sin(2 * np.pi * f * t) * 0.6 + rng.standard_normal(len(t)) * 0.3) * np.exp(-t * 160)

def chime():
    t = np.arange(int(1.4 * SR)) / SR
    return (np.sin(2 * np.pi * 1318.5 * t) + 0.7 * np.sin(2 * np.pi * 1975.5 * t) * (t > 0.09)) * np.exp(-t * 3.5) * 0.5

# ---- score -------------------------------------------------------------
# Pads run the whole film, softer during the lag and the security act.
def pad_level(t):
    if t < RACE: return 0.10
    if t < TRUST: return 0.16
    if t < NETWORK: return 0.12
    if t < END: return 0.15
    return 0.20
t = 0.0
while t < END:
    c = chord_at(t)
    for name, octv in PROG[c]:
        add(pad_note(hz(name, octv), CHORD + 1.4, 0.25 if t < 24 else 0.35), t, pad_level(t) * 0.5)
    t += CHORD
# Final resolve on D major, ringing out
for name, octv in [('D', 3), ('F#', 3), ('A', 3), ('D', 4), ('A', 4)]:
    add(pad_note(hz(name, octv), DUR - END, 0.35), END, 0.11)
add(pluck(hz('D', 2), 4.0, 0.9), END, 0.35)

# Pulse: kick on every beat, bass on the root, hats off the beat.
def pulse(a, b, g=1.0, hats=True):
    t = a
    while t < b - 0.01:
        add(kick(), t, 0.42 * g)
        root = ROOTS[chord_at(t)]
        add(pluck(hz(*root), BEAT * 0.95, 3.0), t, 0.30 * g)
        if hats:
            add(hat(), t + BEAT / 2, 0.10 * g, pan=0.3)
        t += BEAT
pulse(RACE + 0.3, NUMBER, 0.8)
pulse(NUMBER, TRUST, 1.0)
pulse(SPOTLIGHTS[0], NETWORK, 0.45, hats=False)
pulse(NETWORK, END, 0.75)

# Desktop audio during the race: a bright arpeggio heard only on the VidVNC (right) side.
def arp(a, b, g, pan):
    t, i = a, 0
    while t < b - 0.01:
        name, octv = PROG[chord_at(t)][i % 4]
        add(pluck(hz(name, octv + 2), 0.4, 7.0), t, g, pan)
        t += BEAT / 2
        i += 1
arp(RACE + 3.8, NUMBER, 0.16, 0.9)
arp(NUMBER, APP, 0.12, 0.0)
arp(APP + 4, TRUST, 0.08, 0.0)

# Low drone under the security act
tt = np.arange(int((NETWORK - TRUST) * SR)) / SR
drone = np.sin(2 * np.pi * hz('D', 1) * tt) * env(len(tt), 1.5, 2.0)
add(drone, TRUST, 0.18)

# ---- sound effects -----------------------------------------------------
# Late frames in the lag shot: a low tick on each stale frame update (8 to 12 s).
def vnc_time(x):
    step = 0.2 + 0.12 * abs(np.sin(np.floor(x * 3)))
    return np.floor((x - 0.45) / step) * step
prev = None
for k in range(int(8 * 60), int(12 * 60)):
    x = k / 60
    v = vnc_time(x)
    if prev is not None and v != prev:
        add(click(420, 0.04), x, 0.22)
    prev = v
add(click(2400, 0.025), 33.8, 0.35)          # cursor click on Connect a Device
add(chime(), 38.6, 0.45)                      # the desktop opens on the phone
for i, t in enumerate(SPOTLIGHTS):            # the spotlight moves to the next part
    add(click(1500 - i * 150, 0.05), t, 0.4)

mix = np.stack([L, R], axis=1)
mix /= max(1e-9, np.abs(mix).max()) / 0.9
sf.write(out_path, mix.astype(np.float32), SR)
print(f"wrote {out_path}: {DUR:.1f} s")
