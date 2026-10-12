"""Builds the voiceover track and its captions from voiceover.json with Kokoro TTS.

usage: python voiceover.py <cache dir> <voiceover.json> <out.wav> <out.srt> [duration]
Each line starts at its "at" time; a line that would overlap the next one is reported.
"""
import json, sys
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro

cache, spec_path, out_wav, out_srt = sys.argv[1:5]
duration = float(sys.argv[5]) if len(sys.argv) > 5 else 75.0
spec = json.load(open(spec_path))
k = Kokoro(f"{cache}/models/kokoro-v1.0.onnx", f"{cache}/models/voices-v1.0.bin")
sr = 24000
track = np.zeros(int(duration * sr), dtype=np.float32)
cues, problems = [], []
for i, line in enumerate(spec["lines"]):
    audio, sr = k.create(line["text"], voice=spec["voice"], speed=spec.get("speed", 1.0), lang=spec.get("lang", "en-us"))
    start = int(line["at"] * sr)
    end = start + len(audio)
    if end > len(track):
        track = np.concatenate([track, np.zeros(end - len(track), dtype=np.float32)])
    track[start:end] += audio
    t1 = line["at"] + len(audio) / sr
    nxt = spec["lines"][i + 1]["at"] if i + 1 < len(spec["lines"]) else duration
    if t1 > nxt:
        problems.append(f"line {i + 1} ends at {t1:.2f}s, after the next cue at {nxt:.2f}s")
    cues.append((line["at"], t1, line.get("caption", line["text"])))
    print(f"{i + 1:2d}  {line['at']:6.2f} -> {t1:6.2f}  {line['text']}")
sf.write(out_wav, track, sr)

def ts(x):
    ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
with open(out_srt, "w") as f:
    for n, (a, b, text) in enumerate(cues, 1):
        f.write(f"{n}\n{ts(a)} --> {ts(b + 0.3)}\n{text}\n\n")
for p in problems:
    print("WARNING:", p)
