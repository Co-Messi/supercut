#!/usr/bin/env python3
"""Deterministic electronic-music bed synthesizer for supercut.

Pure subtractive/additive synthesis — oscillators, filtered noise, envelopes.
No vocal source exists, so no vocals/chants/yells are possible. Four moods.
Outputs 16-bit stereo WAV; ffmpeg encodes the loopable MP3 bed afterward.
"""
import sys
import numpy as np
from scipy import signal as sig

SR = 44100

def semitone(base, n):
    return base * (2.0 ** (n / 12.0))

# note name -> midi-ish frequency (A4=440)
A4 = 440.0
NAMES = {"C":-9,"C#":-8,"D":-7,"D#":-6,"E":-5,"F":-4,"F#":-3,"G":-2,"G#":-1,"A":0,"A#":1,"B":2}
def note(name, octave):
    semis = NAMES[name] + (octave - 4) * 12
    return semitone(A4, semis)

def adsr(n, a, d, s, r, sr=SR):
    a_n, d_n, r_n = int(a*sr), int(d*sr), int(r*sr)
    a_n = min(a_n, n); d_n = min(d_n, max(0, n-a_n)); r_n = min(r_n, max(0, n-a_n-d_n))
    sus_n = max(0, n - a_n - d_n - r_n)
    env = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False) if a_n else np.array([]),
        np.linspace(1, s, d_n, endpoint=False) if d_n else np.array([]),
        np.full(sus_n, s),
        np.linspace(s, 0, r_n) if r_n else np.array([]),
    ])
    if len(env) < n: env = np.concatenate([env, np.zeros(n-len(env))])
    return env[:n]

def saw(freq, n, detune=0.0, sr=SR):
    t = np.arange(n)/sr
    out = np.zeros(n)
    for d in ([-detune, 0.0, detune] if detune else [0.0]):
        f = freq * (2.0**(d/1200.0))
        ph = (t*f) % 1.0
        out += 2.0*ph - 1.0
    return out/ (3 if detune else 1)

def sine(freq, n, sr=SR):
    t = np.arange(n)/sr
    return np.sin(2*np.pi*freq*t)

def square(freq, n, duty=0.5, sr=SR):
    t = np.arange(n)/sr
    ph = (t*freq) % 1.0
    return np.where(ph < duty, 1.0, -1.0)

def lowpass(x, cutoff, sr=SR, order=4):
    cutoff = min(cutoff, sr/2*0.98)
    b, a = sig.butter(order, cutoff/(sr/2), btype="low")
    return sig.lfilter(b, a, x)

def highpass(x, cutoff, sr=SR, order=2):
    b, a = sig.butter(order, cutoff/(sr/2), btype="high")
    return sig.lfilter(b, a, x)

def kick(n, sr=SR, f0=110, f1=45, drop=0.03, dur=0.28):
    L = int(dur*sr); L = min(L, n)
    t = np.arange(L)/sr
    f = f1 + (f0-f1)*np.exp(-t/drop)
    ph = 2*np.pi*np.cumsum(f)/sr
    body = np.sin(ph) * np.exp(-t/0.16)
    click = (np.random.RandomState(1).randn(L)*np.exp(-t/0.004))*0.3
    out = np.zeros(n); out[:L] = np.tanh((body+click)*1.4)
    return out

def hat(n, sr=SR, dur=0.05, rs=0):
    L = int(dur*sr); L=min(L,n)
    t=np.arange(L)/sr
    noise = np.random.RandomState(rs).randn(L)
    noise = highpass(noise, 7000)
    out=np.zeros(n); out[:L]=noise*np.exp(-t/0.012)
    return out

def place(track, x, at):
    i=int(at*SR); e=min(len(track), i+len(x)); track[i:e]+=x[:e-i]

def synth_pad(freqs, dur, detune=6.0, cutoff=1800):
    n=int(dur*SR)
    mix=np.zeros(n)
    for f in freqs: mix+=saw(f,n,detune=detune)
    mix/=len(freqs)
    mix=lowpass(mix, cutoff)
    mix*=adsr(n, 0.4, 0.3, 0.85, 0.5)
    return mix

def arp_note(freq, dur, cutoff=2600):
    n=int(dur*SR)
    x=square(freq,n,duty=0.45)*0.5 + saw(freq,n)*0.5
    x=lowpass(x,cutoff)
    x*=adsr(n,0.004,0.06,0.35,0.08)
    return x

def bass_note(freq, dur, cutoff=600):
    n=int(dur*SR)
    x=saw(freq,n)*0.6+sine(freq,n)*0.6
    x=lowpass(x,cutoff)
    x*=adsr(n,0.006,0.08,0.7,0.06)
    return x

def build(mood, bpm, bars, key_root, chords, seed):
    rng=np.random.RandomState(seed)
    beat=60.0/bpm
    bar=beat*4
    total=bar*bars
    n=int(total*SR)+SR
    L=np.zeros(n); R=np.zeros(n)

    # chord pads (2 bars each, cycling)
    padtrk=np.zeros(n)
    for b in range(bars):
        ch=chords[b % len(chords)]
        freqs=[note(nm, oc) for (nm,oc) in ch]
        p=synth_pad(freqs, bar*1.02, detune=6 if mood!="midnight" else 4,
                    cutoff=1500 if mood=="midnight" else 2000)
        place(padtrk, p*0.22, b*bar)
    # gentle stereo width on pad
    L+=padtrk; R+=lowpass(padtrk, 6000)*0.96

    # bass — root of current chord, rhythmic
    basstrk=np.zeros(n)
    has_beat = mood in ("pulse","midnight","momentum")
    for b in range(bars):
        root=chords[b%len(chords)][0]
        rf=note(root[0], root[1]-1)
        if mood=="daybreak":
            for k in range(4):
                place(basstrk, bass_note(rf, beat*0.9)*0.5, b*bar+k*beat)
        elif mood=="momentum":
            for k in range(8):
                place(basstrk, bass_note(rf, beat*0.45)*0.5, b*bar+k*beat*0.5)
        else:  # pulse / midnight: offbeat pulse
            for k in range(4):
                place(basstrk, bass_note(rf, beat*0.5)*0.5, b*bar+k*beat+beat*0.5)
    basstrk=lowpass(basstrk, 700)
    L+=basstrk; R+=basstrk

    # drums
    if has_beat:
        drum=np.zeros(n)
        nbeats=int(bars*4)
        for k in range(nbeats):
            place(drum, kick(int(0.3*SR))*0.9, k*beat)
        # hats offbeat
        step = beat/2 if mood!="momentum" else beat/2
        nh=int(total/step)
        for k in range(nh):
            if mood=="momentum" or k%2==1:
                place(drum, hat(int(0.06*SR), rs=k)*0.28, k*step)
        L+=drum; R+=drum

    # arpeggio (skip on midnight for sparseness; sparse on pulse)
    if mood in ("pulse","daybreak","momentum"):
        arp=np.zeros(n)
        arp_dur = beat/2
        for b in range(bars):
            ch=chords[b%len(chords)]
            seq=[note(nm,oc+1) for (nm,oc) in ch]
            seq=seq+[seq[1]]  # small pattern
            steps=int(bar/arp_dur)
            for s in range(steps):
                f=seq[s%len(seq)]
                gain = 0.14 if mood!="momentum" else 0.16
                place(arp, arp_note(f, arp_dur*0.95, cutoff=2200+ (s%4)*250)*gain, b*bar+s*arp_dur)
        # pan arp slightly right, delay copy left for width
        d=int(0.02*SR)
        L+=np.concatenate([np.zeros(d), arp[:-d]])*0.8
        R+=arp

    # master: soft filter sweep intro, gentle bus compression (tanh), fades
    stereo=np.vstack([L,R])
    # subtle high-shelf tame + soft clip
    stereo=np.tanh(stereo*0.8)*0.9
    # trim to exact loop length (whole bars) for clean looping
    loop_n=int(total*SR)
    stereo=stereo[:, :loop_n]
    # normalize
    peak=np.max(np.abs(stereo))+1e-9
    stereo=stereo/peak*0.89
    return stereo.T  # (n,2)

def write_wav(path, data):
    from scipy.io import wavfile
    wavfile.write(path, SR, (data*32767).astype(np.int16))

MOODS = {
    # mood: (bpm, bars, chords[list of (name,octave) triads])
    "pulse": (104, 16, [
        [("A",3),("C",4),("E",4)], [("F",3),("A",3),("C",4)],
        [("C",4),("E",4),("G",4)], [("G",3),("B",3),("D",4)],
    ], 11),
    "daybreak": (112, 16, [
        [("C",4),("E",4),("G",4)], [("G",3),("B",3),("D",4)],
        [("A",3),("C",4),("E",4)], [("F",3),("A",3),("C",4)],
    ], 21),
    "midnight": (100, 16, [
        [("A",3),("C",4),("E",4)], [("F",3),("A",3),("C",4)],
        [("D",3),("F",3),("A",3)], [("E",3),("G",3),("B",3)],
    ], 31),
    "momentum": (124, 16, [
        [("E",3),("G",3),("B",3)], [("C",4),("E",4),("G",4)],
        [("D",4),("F#",4),("A",4)], [("A",3),("C#",4),("E",4)],
    ], 41),
}

if __name__ == "__main__":
    out_dir = sys.argv[1]
    for mood,(bpm,bars,chords,seed) in MOODS.items():
        data=build(mood,bpm,bars,None,chords,seed)
        write_wav(f"{out_dir}/{mood}.wav", data)
        print(f"{mood}: {len(data)/SR:.1f}s")
