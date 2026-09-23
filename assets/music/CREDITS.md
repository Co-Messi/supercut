# Bundled music — provenance & license

All four tracks are **original instrumental works produced for supercut**,
synthesized from pure oscillators (sub bass, drum machine, filtered noise
hats, saw-wave pads, arpeggios) by `tools/synth-music.py` — there is no vocal
source, no sample, and no pre-existing song anywhere in the signal chain, so
the tracks cannot contain vocals.

**Reproducing the beds end-to-end.** `tools/synth-music.py` regenerates
equivalent beds (not necessarily bit-identical) from scratch. It needs:

  * Python packages `numpy` and `scipy` — `pip install numpy scipy`
  * `ffmpeg` on your PATH

Run `python3 tools/synth-music.py assets/music`. For each mood it synthesizes a
short WAV loop, then ffmpeg self-crossfades that loop to ~92s
(`acrossfade=d=1` ×3 → `atrim=0:92`), loudness-normalizes it
(`loudnorm=I=-15:TP=-1.5:LRA=9`), and encodes a 192 kbit/s 44.1 kHz stereo MP3 —
the exact pipeline that produced the checked-in beds.

To the extent the maintainers hold any rights in these recordings, they are
dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
Use them in your videos — commercial or not — with no attribution required.

| track          | vibe                          | length | bpm  |
| -------------- | ----------------------------- | ------ | ---- |
| `pulse.mp3`    | minimal tech-house, sleek     | 92s    | ~104 |
| `daybreak.mp3` | bright melodic house, upbeat  | 92s    | ~110 |
| `midnight.mp3` | dark synthwave/techno, premium| 92s    | ~100 |
| `momentum.mp3` | driving minimal techno        | 91s    | ~122 |
