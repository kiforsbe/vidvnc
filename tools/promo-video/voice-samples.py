"""Draft 1: reads four lines of the script in each candidate voice with Kokoro TTS.

usage: python voice-samples.py <cache dir> <out dir> <voice> [voice ...]
Writes <out dir>/<voice>.wav; promo.mjs turns them into numbered .m4a files.
"""
import sys, soundfile as sf, numpy as np
from kokoro_onnx import Kokoro
d=sys.argv[1]; out=sys.argv[2]
k=Kokoro(f"{d}/models/kokoro-v1.0.onnx", f"{d}/models/voices-v1.0.bin")
lines=["You've done this before. Reach for your desktop, and it fights back.",
"About sixty-three milliseconds from your screen to theirs. Video and sound, together.",
"You decide who gets in. Everything is encrypted.",
"VidVNC. Your desktop, in real time, on your network."]
for v in sys.argv[3:]:
    parts=[]
    for l in lines:
        a,sr=k.create(l, voice=v, speed=1.0, lang="en-gb" if v.startswith("b") else "en-us")
        parts += [a, np.zeros(int(sr*0.6),dtype=a.dtype)]
    sf.write(f"{out}/{v}.wav", np.concatenate(parts), sr)
    print(v, "ok")
