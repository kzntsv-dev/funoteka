/**
 * How long an MPEG audio stream plays.
 *
 * **Sources, and which parts have one.** The frame header — where each field
 * sits, the bitrate tables, the sample rates, the slot a padding bit adds — is
 * checked against the MP3'Tech page on it (`mp3-tech.org/programmer/
 * frame_header.html`, saved as `2026-09-12-mpeg-audio-frame-header---mp3-tech.md`).
 * That page is **secondary**: ISO/IEC 11172-3, the standard itself, is not
 * openly available, so nothing here is verified against the standard, and
 * saying "checked against the standard" would be false.
 *
 * Three things in this file that page does not cover, and no other source in
 * hand does either — the samples a frame carries, the frame-length formula, and
 * the Xing/Info and VBRI header layouts with the side-info sizes that lead to
 * them. Those are held up by measurement instead: on 700 mp3 files here the
 * length this reader reports is identical to the frame count ffprobe arrives at
 * when it reads every frame (`-count_frames`), which is an independent
 * instrument reaching the same number by a different route. 528 of those files
 * take the Xing/Info path, so its offsets are exercised rather than assumed.
 * **VBRI is exercised by nothing**: no file in the collection carries one, and
 * it remains the one path here that rests on recollection.
 *
 * mp3 has no field that states this outright the way FLAC's STREAMINFO does,
 * which is not the same as saying it is unknown — every player knows it exactly,
 * and it knows it from the file alone. There are two ways and both are here:
 *
 *   - a **Xing/Info** header (LAME writes one; Fraunhofer writes `VBRI`), which
 *     states the frame count and costs a multiplication; or
 *   - **walking the frames**, which needs no assumption about the stream and is
 *     exact for constant and variable bitrate alike.
 *
 * There is deliberately no "assume CBR and divide the file size by the bitrate"
 * shortcut, though it is the next thing anyone reaches for. It is wrong on any
 * file with a trailing ID3v1 or APEv2 tag, wrong on a free-format stream, and
 * wrong on the variable bitrate rips where it is most tempting — and the frames
 * are already in memory, so walking them costs a jump per frame and no
 * assumption at all.
 *
 * Counting is also what makes it possible to say the length is *not* known,
 * which is the other half of this module. A walk that runs out of frames with
 * most of the file still ahead of it has lost the stream, and the number it
 * would otherwise report is short by however much it skipped — plausible,
 * wrong, and indistinguishable downstream from a correct one. That case is
 * refused: the caller is told to ask something else, and ffprobe answers. The
 * same refusal is what stops a file that merely *looks* like a stream — a
 * couple of headers matching by chance inside an mp4 — from being claimed as
 * one; see `MIN_STREAM_FRAMES` and `REFUSAL_MIN_GAP`.
 *
 * The tables are the part that is easy to get subtly wrong, and every one of
 * them differs between MPEG versions:
 *
 *   - samples per frame: Layer III is 1152 at MPEG-1 and **576** at MPEG-2/2.5.
 *     Using 1152 everywhere reports a low-bitrate rip at double its length.
 *   - the bitrate table: MPEG-2/2.5 Layer III starts at 8 kbps and stops at
 *     160; MPEG-1 runs 32 to 320. Reading one with the other's table gives a
 *     plausible, wrong number.
 *   - the sample rate: 44.1/48/32 kHz at MPEG-1, half that at MPEG-2, half
 *     again at MPEG-2.5.
 */

/**
 * Bitrate in kbps by table index, keyed by the same layer field as everything
 * else — **1 is Layer III**. Index 0 is "free" and 15 is invalid.
 *
 * Every value here is the MP3'Tech table, transcribed column for column: V1/L1
 * runs 32 to 448, V1/L2 32 to 384, V1/L3 32 to 320, V2/L1 32 to 256, and
 * V2/L2 with L3 8 to 160 — the last being the one that catches people, since
 * low-bitrate MPEG-2 audio is exactly where a wrong table is least obvious.
 *
 * Getting a layer's key wrong here is the quietest failure in the file: read
 * Layer III's index 9 against Layer I's table and a 128 kbps stream reports as
 * 288, which is a real bitrate at a real index and produces a frame length of
 * 864 instead of 384 — no error, no exception, just a track three times too
 * long.
 */
const BITRATES_V1 = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0], // Layer III
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0], // Layer II
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0], // Layer I
} as const;

const BITRATES_V2 = {
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0], // Layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0], // Layer II
  3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0], // Layer I
} as const;

/** Indexed by the two-bit version field: 0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1. */
const SAMPLE_RATES = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
} as const;

/**
 * Samples per frame, indexed by version field and then by the two-bit layer
 * field — where **1 is Layer III**, 2 is Layer II and 3 is Layer I.
 *
 * **No source in hand states these numbers.** The MP3'Tech page describes the
 * 32-bit header and stops; ISO/IEC 11172-3 has them and is paywalled. So this
 * table, and the frame-length formula that is built on it, are the recollection
 * the rest of this file is checked against text — held up by measurement
 * instead: over 700 mp3 files the length derived from them matches the frame
 * count ffprobe gets by reading every frame, exactly, to the millisecond. A
 * wrong figure here cannot hide inside that.
 *
 * Getting this table's keys the wrong way round is worth spelling out, because
 * it is silent: Layer I carries 384 samples and Layer III 1152, so swapping
 * them reports a three-second track for a nine-second one and nothing looks
 * malformed.
 */
const SAMPLES_PER_FRAME = {
  3: { 1: 1152, 2: 1152, 3: 384 }, // MPEG-1
  2: { 1: 576, 2: 1152, 3: 384 }, // MPEG-2
  0: { 1: 576, 2: 1152, 3: 384 }, // MPEG-2.5
} as const;

export interface Frame {
  /** Where this frame's header starts. */
  at: number;
  /** Bytes this frame occupies, header included. */
  size: number;
  bitrateKbps: number;
  sampleRate: number;
  samplesPerFrame: number;
  mono: boolean;
  /** Where the Xing/Info/VBRI header would begin, if this frame carries one. */
  sideInfoAt: number;
  versionField: number;
  /**
   * The MPEG layer: 1 is Layer III, 2 is Layer II, 3 is Layer I.
   *
   * Which *codec* the stream is, said the way the format says it — the field the
   * tables are keyed by, carried out so that a reader which walked frames can
   * name what it walked instead of leaving the caller to guess.
   */
  layerField: number;
}

/** The codec a layer field names, as ffprobe would name it. */
export function codecOfLayer(layerField: number): string {
  return layerField === 3 ? 'mp1' : layerField === 2 ? 'mp2' : 'mp3';
}

/**
 * Read the frame whose header starts at `at`, or null if nothing valid does.
 *
 * The 32-bit header is the MP3'Tech one field for field — `AAAAAAAA AAABBCCD
 * EEEEFFGH IIJJKLMM`, where B is the version, C the layer, E the bitrate index,
 * F the sample rate, G padding, I the channel mode. The shifts below are that
 * layout read as big-endian bits, and the three values each field reserves —
 * version 1, layer 0, bitrate 15, sample rate index 3 — are refused rather than
 * guessed at, because a frame built on one of them is not a frame.
 */
export function readFrame(bytes: Uint8Array, at: number): Frame | null {
  if (at + 4 > bytes.length) return null;
  if (bytes[at] !== 0xff || ((bytes[at + 1] ?? 0) & 0xe0) !== 0xe0) return null;

  const versionField = ((bytes[at + 1] ?? 0) >> 3) & 0x03;
  const layerField = ((bytes[at + 1] ?? 0) >> 1) & 0x03;
  const bitrateIndex = ((bytes[at + 2] ?? 0) >> 4) & 0x0f;
  const rateIndex = ((bytes[at + 2] ?? 0) >> 2) & 0x03;
  const padding = ((bytes[at + 2] ?? 0) >> 1) & 0x01;

  // 1 is reserved as a version, 0 as a layer, and both 0 and 15 as bitrates.
  if (versionField === 1 || layerField === 0) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;

  const table = versionField === 3 ? BITRATES_V1 : BITRATES_V2;
  const bitrateKbps = table[layerField as 1 | 2 | 3][bitrateIndex] ?? 0;
  const sampleRate = SAMPLE_RATES[versionField as 0 | 2 | 3][rateIndex] ?? 0;
  const samplesPerFrame = SAMPLES_PER_FRAME[versionField as 0 | 2 | 3][layerField as 1 | 2 | 3];
  if (bitrateKbps === 0 || sampleRate === 0) return null;

  const mono = (((bytes[at + 3] ?? 0) >> 6) & 0x03) === 3;
  // A Layer I frame counts in four-byte slots; Layers II and III do not.
  const size =
    layerField === 3
      ? (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + padding) * 4
      : Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;

  // Side info sits between the header and any Xing/Info header.
  const sideInfo = versionField === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;

  return {
    at,
    size,
    bitrateKbps,
    sampleRate,
    samplesPerFrame,
    mono,
    sideInfoAt: at + 4 + sideInfo,
    versionField,
    layerField,
  };
}

/**
 * The first frame at or after `from`, resynchronising past leading garbage.
 *
 * Two frames, not one. A plausible-looking header occurs by chance inside
 * padding and artwork constantly, and believing the first one costs the whole
 * length: everything walked from a false start is noise counted as frames. On
 * a real file in the collection that read as 98 seconds against a true 24, and
 * the rate at which a lone coincidence is followed by another at exactly the
 * right offset is low enough to make this the whole of the test.
 */
export function firstFrame(bytes: Uint8Array, from: number): Frame | null {
  for (let at = from; at + 4 <= bytes.length; at += 1) {
    const frame = readFrame(bytes, at);
    if (frame === null) continue;
    if (readFrame(bytes, at + frame.size) !== null) return frame;
  }
  return null;
}

function uint32be(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

function magicAt(bytes: Uint8Array, at: number, magic: string): boolean {
  if (at + magic.length > bytes.length) return false;
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[at + i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Frames stated by the header, or null when there is no usable one.
 *
 * `Xing` marks a variable-bitrate stream and `Info` a constant one, but both
 * carry the same count and neither is trusted blindly — the count is only used
 * when the flag saying it is present is set.
 *
 * The two layouts are **not from a specification in hand** — no primary text
 * covers either, and MP3'Tech does not describe them. Xing and Info are the
 * same nine bytes of header: the magic, a flags word, then the frame count.
 * VBRI, Fraunhofer's, is longer and puts the count fourteen bytes in. On the
 * collection, 528 files carry Xing or Info and their stated counts agree with
 * the frames that are actually there.
 *
 * **VBRI is carried by no file in the collection**, so the offsets above it were
 * settled by construction instead: a stream was built with a VBRI header and
 * handed to ffmpeg, which read 522 ms from a twenty-frame stream and 26 ms when
 * the count was moved ten bytes earlier — the same two answers this reader
 * gives, on the right layout and on the deliberately wrong one. Two parsers
 * written independently agreeing on both is what stands in for the text neither
 * of them had, and the fixture in `test/helpers/bytes.ts` writes the same bytes
 * so the branch is exercised rather than assumed.
 */
function framesFromHeader(bytes: Uint8Array, frame: Frame): number | null {
  const at = frame.sideInfoAt;

  if (magicAt(bytes, at, 'Xing') || magicAt(bytes, at, 'Info')) {
    const flags = uint32be(bytes, at + 4);
    if ((flags & 0x01) === 0) return null;
    const frames = uint32be(bytes, at + 8);
    return frames > 0 ? frames : null;
  }

  if (magicAt(bytes, at, 'VBRI')) {
    const frames = uint32be(bytes, at + 14);
    return frames > 0 ? frames : null;
  }

  return null;
}

/**
 * Whether this frame is the encoder's own header rather than audio.
 *
 * LAME writes `Xing`/`Info` there and Fraunhofer `VBRI`, and whatever the flags
 * word says afterwards, the frame itself carries no audio a decoder plays. A
 * stream cut out of the middle of a file has to leave it out — not only because
 * it states the *whole* file's frame count and would misreport the segment's
 * length, but because the walk above does not count it either, so keeping it
 * would put the served bytes one frame out of step with the times they were
 * chosen by.
 */
export function isEncoderFrame(bytes: Uint8Array, frame: Frame): boolean {
  const at = frame.sideInfoAt;
  return magicAt(bytes, at, 'Xing') || magicAt(bytes, at, 'Info') || magicAt(bytes, at, 'VBRI');
}

/** How long the stream plays, and whether that answer can be trusted. */
export interface MpegLength {
  durationMs: number;
  /** The codec the frames are, which is a thing a walk knows and a tag does not. */
  codec: string;
  /**
   * What the frames say the audio is, in the units the meta layer stores.
   *
   * Both sit in the same 32-bit header the length does, so a reader that found
   * a frame to measure has already read them — they are carried out because
   * leaving them null cost the collection twice (task:2910). The decision path
   * spawned `ffprobe` to learn what these bytes state outright, and an mp3
   * whose channel count nothing had filled was re-encoded whole rather than
   * served, since `alreadyIs` cannot answer a cap it has nothing to compare.
   *
   * The sample rate is a property of the stream rather than of a frame — it
   * cannot change between frames of one MPEG audio stream — so the first frame
   * states it for all of them. The channel mode is the two-bit field read as
   * `mono`; every other mode (stereo, joint, dual) is two channels.
   */
  sampleRate: number;
  channels: number;
  /**
   * The walk gave up with the stream still well ahead of it, so the length is
   * short by however much was skipped.
   *
   * This is not a damaged-file flag; it is a statement that this reader cannot
   * answer, and that the caller should ask one that can. The number beside it
   * is withheld from storage for the same reason — see `TagRead.durationRefused`.
   */
  refused: boolean;
}

/**
 * A gap between where the walk stopped and the end of the bytes has to be both
 * absolutely and relatively large before it means a lost stream.
 *
 * Both tests earn their place. The absolute one clears the tags that sit after
 * the audio in an ordinary rip — an ID3v1 block is 128 bytes and an APEv2 one
 * carrying artwork can be a hundred kilobytes, and neither is a lost frame. The
 * relative one keeps a fixed byte threshold from calling a long track damaged
 * because its artwork is large: what makes a gap a loss is a stream continuing
 * past it, and a gap that is a tenth of the file cannot be the tail of it.
 *
 * Erring towards refusing is deliberate and cheap. A needless refusal costs one
 * ffprobe spawn and returns the same number; a missed one stores a short length
 * that nothing downstream can tell from a correct one.
 */
const REFUSAL_MIN_GAP = 4096;
const REFUSAL_GAP_SHARE = 8;

/**
 * How many frames in a row it takes to call these bytes an MPEG stream at all.
 *
 * Without this, a file that is not an MPEG stream can still be claimed as one:
 * `firstFrame` accepts a header that is followed by another at exactly the right
 * offset, and inside unrelated data that happens. Measured over 229 real `.m4a`
 * files — which are MP4, share no structure with MPEG audio, and are simply not
 * understood here — every such coincidence ran to **exactly two frames**, the
 * minimum `firstFrame` will accept, and no further. The genuine damaged stream
 * this reader has to hand over (`02. 218 Tracks.mp3`) ran to **657**.
 *
 * So the populations do not overlap and the line goes in the space between
 * them. Eight frames is a fifth of a second — far below any track a music
 * collection holds, and four times the most a coincidence has ever produced.
 * The margin does not need to be wider than that: two is not where coincidence
 * happens to stop, it is where `firstFrame` stops looking, and a third frame
 * arriving at exactly the computed offset is already the unlikely part.
 *
 * Below the line the honest answer is "no stream here", which leaves the file
 * reported as a format this reader does not understand. That is a worse answer
 * than a duration, but it is a true one — and claiming an m4a is an mpeg
 * container is not. It cost the collection a correct count of what is
 * unreadable, and it did so for 14 files out of 229 while the other 215 were
 * still being described accurately.
 */
const MIN_STREAM_FRAMES = 8;

/**
 * How long the MPEG stream starting at `from` plays, and whether that is known.
 *
 * Null when no frame can be found at all, which is the honest answer for
 * something that is not a stream — and this never throws, because the caller is
 * a scan over a whole collection and one damaged file must not stop it.
 */
export function mpegLength(bytes: Uint8Array, from: number): MpegLength | null {
  const first = firstFrame(bytes, from);
  if (first === null) return null;

  // A frame count written by the encoder is a statement, not a measurement —
  // nothing was walked, so there is nothing to have lost.
  const stated = framesFromHeader(bytes, first);
  if (stated !== null) {
    return {
      durationMs: Math.round((stated * first.samplesPerFrame * 1000) / first.sampleRate),
      codec: codecOfLayer(first.layerField),
      sampleRate: first.sampleRate,
      channels: first.mono ? 1 : 2,
      refused: false,
    };
  }

  // Walk the stream. Each frame states its own length, so this is a jump per
  // frame rather than a pass over the bytes.
  //
  // Contiguous, and it stops at the first position that is not a frame. There
  // was a resync here that looked for the next plausible header after a break,
  // and it was worse than useless: MPEG frames run back to back, so a break
  // means the stream ended, and every "recovered" position was a coincidence in
  // trailing data counted as audio. What replaced it is not a better resync but
  // the refusal below — a walk that loses the stream no longer has to guess at
  // the rest, because it can decline to answer.
  let at = first.at;
  let samples = 0;
  let frames = 0;

  for (let guard = 0; guard < 1_000_000; guard += 1) {
    const frame = readFrame(bytes, at);
    if (frame === null) break;

    samples += frame.samplesPerFrame;
    frames += 1;
    at += frame.size;
  }

  // Too few frames to have found a stream — see `MIN_STREAM_FRAMES`. Not a
  // refusal: there is nothing here to hand over, because there is nothing here.
  if (frames < MIN_STREAM_FRAMES) return null;

  const gap = bytes.length - at;
  return {
    durationMs: Math.round((samples * 1000) / first.sampleRate),
    codec: codecOfLayer(first.layerField),
    sampleRate: first.sampleRate,
    channels: first.mono ? 1 : 2,
    refused: gap > REFUSAL_MIN_GAP && gap * REFUSAL_GAP_SHARE > bytes.length - from,
  };
}
