/**
 * Byte fixtures for the encoding tests.
 *
 * Shared, not copied. Both test files build Russian bytes, and if the encoder
 * itself were wrong they would agree on the wrong bytes — so there has to be
 * one copy to be wrong in. Setup glue like `fixture`/`prepare` may reasonably
 * differ per file; a domain byte-encoder may not.
 *
 * Node's `latin1` codec truncates a code point to its low byte, so it silently
 * turns U+201C into 0x1C. Anything above 0x7F outside 0xA0..0xFF is therefore
 * built as an explicit byte list rather than passed through a codec.
 */

/** CP1251 for Cyrillic: U+0410..U+044F map linearly onto 0xC0..0xFF. */
export function cp1251(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8); // Ё
    else if (c === 0x451) out.push(0xb8); // ё
    else if (c < 0x80) out.push(c);
    else if (c >= 0xa0 && c <= 0xbf) out.push(c); // the range CP1252 shares
    else throw new Error(`no CP1251 byte for ${ch} (U+${c.toString(16)})`);
  }
  return Buffer.from(out);
}

/** UTF-16 big-endian, which no Node codec writes for us. */
export function utf16be(text: string): Buffer {
  return Buffer.from(text, 'utf16le').swap16();
}

/** ID3v2 sizes are seven bits per byte, so a large frame stays readable. */
export function synchsafe(value: number): Buffer {
  return Buffer.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

/** Text bytes for an ID3v2 frame, as the declared encoding byte says to write them. */
export function id3Text(encoding: number, text: string): Buffer {
  if (encoding === 3) return Buffer.from(text, 'utf8');
  if (encoding === 1) return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 2) return utf16be(text);
  return Buffer.from(text, 'latin1');
}

/**
 * Escape a frame's data, as ID3v2.4 unsynchronisation requires.
 *
 * The writer's half of the scheme, and the reader's is written separately —
 * a fixture that called the reader's own function to check the reader would
 * agree with it about any mistake the two shared. The spec names exactly two
 * cases: a `FF` before a byte whose top three bits are set, and a `FF` before
 * an existing `00` (which is why all `FF 00` have to become `FF 00 00` — so the
 * decoder can tell an escaped `FF` from a literal `FF 00`).
 */
export function unsynchronise(bytes: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    out.push(byte);
    if (byte !== 0xff) continue;
    const next = bytes[i + 1];
    if (next === 0x00 || (next !== undefined && (next & 0xe0) === 0xe0)) out.push(0x00);
  }
  return Buffer.from(out);
}

/**
 * An ID3v2 tag.
 *
 * `version` matters to the reader and not just to the writer: a v2.3 frame
 * states its size as a plain big-endian number and a v2.4 frame as four
 * seven-bit bytes, so a tag carrying one long frame is decoded correctly by a
 * reader that knows which, and illegibly by one that assumed.
 *
 * The v2.4 unsynchronisation knobs are the two the spec separates. A frame can
 * be escaped on its own (`unsynchronised`, which also sets the frame's format
 * flag), or the tag can declare that it escaped every frame at once
 * (`unsynchroniseAll`, the header flag) — and the spec is explicit that a set
 * header flag means *all* of them, so it escapes every frame rather than
 * trusting the caller to pair the two. `dataLengthIndicator` is on by default
 * for an escaped frame because a writer that escaped has the length in hand,
 * and off is worth asking for: the spec calls the indicator desirable and not
 * mandatory, so a reader must not need it.
 *
 * `unsynchroniseAll` means something else on an older version, and the fixture
 * has to write both because they are the two a reader must tell apart. v2.4
 * escapes frame by frame, so the frame sizes count the stored bytes; v2.2 and
 * v2.3 escape the assembled body once, after the frames — and their sizes,
 * written before that, count clean bytes while the tag size counts stored ones
 * (task:2753). A tag built the v2.3 way is what a reader that de-escapes frame
 * by frame gets wrong, which is why the suite could not see the bug until this
 * could write one.
 */
export function id3v2(
  frames: {
    id: string;
    encoding: number;
    text: Buffer;
    /** v2.4: escape this frame's data and say so in its own format flags. */
    unsynchronised?: boolean;
    /** v2.4: write the data length indicator ahead of the data. */
    dataLengthIndicator?: boolean;
    /**
     * The frame's bytes exactly as they should appear after the frame header,
     * for the shapes `encoding`/`text` cannot express — a compressed body, the
     * extra fields a format flag adds. The size is still written here, which is
     * the fiddly part worth sharing; the contents are the caller's.
     */
    raw?: Buffer;
    /** Extra format-flag bits, written beside whatever escaping the frame asks for. */
    format?: number;
  }[],
  options: { version?: 2 | 3 | 4; unsynchroniseAll?: boolean } = {},
): Buffer {
  const version = options.version ?? 3;
  // Declared in the header either way; what it *means* is the version's own.
  const declared = options.unsynchroniseAll === true;
  const allEscaped = declared && version >= 4;
  const bodyEscaped = declared && version < 4;

  const body: Buffer[] = [];
  for (const frame of frames) {
    const data = Buffer.concat([Buffer.from([frame.encoding]), frame.text]);

    const escaped = allEscaped || (version >= 4 && frame.unsynchronised === true);
    const indicator = escaped && frame.dataLengthIndicator !== false;

    let payload = frame.raw ?? (escaped ? unsynchronise(data) : data);
    if (frame.raw === undefined && indicator) {
      const length = Buffer.alloc(4);
      synchsafe(data.length).copy(length);
      payload = Buffer.concat([length, payload]);
    }

    if (version === 2) {
      // v2.2: a three-letter id, a plain three-byte size, and no flags at all —
      // the frame header is six bytes where every later version uses ten. The
      // caller passes the short ids (`TP1`, `TAL`) for this version.
      const short = Buffer.alloc(3);
      short.writeUIntBE(payload.length, 0, 3);
      body.push(Buffer.from(frame.id, 'latin1'), short, payload);
      continue;
    }

    const size = Buffer.alloc(4);
    if (version >= 4) synchsafe(payload.length).copy(size);
    else size.writeUInt32BE(payload.length, 0);

    const flags = Buffer.alloc(2);
    if (version >= 4) {
      flags[1] =
        (frame.unsynchronised === true ? 0x02 : 0) | (indicator ? 0x01 : 0) | (frame.format ?? 0);
    } else if (version === 3) {
      // v2.3's format flags are %ijk00000 — compression, encryption, grouping —
      // so the same bit a v2.4 frame uses for something else means something
      // else here. The caller passes the version's own value.
      flags[1] = frame.format ?? 0;
    }

    body.push(Buffer.from(frame.id, 'latin1'), size, flags, payload);
  }

  const assembled = Buffer.concat(body);
  // The escaping an older version declares is applied to the whole assembled
  // body, frame headers and size fields included — which is exactly why those
  // sizes still describe the bytes they were computed from.
  const payload = bodyEscaped ? unsynchronise(assembled) : assembled;
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([version, 0, declared ? 0x80 : 0]),
    synchsafe(payload.length),
    payload,
  ]);
}

/**
 * A metadata block: one byte naming the type and whether it is the last, then a
 * three-byte big-endian length.
 */
function metadataBlock(type: number, body: Buffer, last: boolean): Buffer {
  const header = Buffer.alloc(4);
  header[0] = (last ? 0x80 : 0) | type;
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
}

/**
 * STREAMINFO, the block every FLAC file must carry first.
 *
 * Note what is stored here: `channels` and `bitsPerSample` go in **minus one**,
 * which is the format's own off-by-one and exactly the kind of thing a reader
 * written from the same assumption as its fixture would never notice. The
 * builder therefore writes the real values and lets the reader subtract.
 */
function streamInfoBody(
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  totalSamples: number,
): Buffer {
  const body = Buffer.alloc(34);
  body.writeUInt16BE(4096, 0); // min block size
  body.writeUInt16BE(4096, 2); // max block size
  // Min and max frame size stay zero: a reader has no business needing them.
  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitsPerSample - 1) << 36n) |
    BigInt(totalSamples);
  body.writeBigUInt64BE(packed, 10);
  return body; // the MD5 that follows stays zero
}

/** VORBIS_COMMENT: a vendor string, a count, then little-endian `NAME=value`s. */
function vorbisCommentBody(
  tags: Record<string, string | string[]>,
  vendor: string,
  rawComments: Buffer[],
): Buffer {
  const encoded: Buffer[] = [];
  for (const [name, value] of Object.entries(tags)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      encoded.push(Buffer.from(`${name}=${one}`, 'utf8'));
    }
  }

  const vendorBytes = Buffer.from(vendor, 'utf8');
  const vendorLength = Buffer.alloc(4);
  vendorLength.writeUInt32LE(vendorBytes.length, 0);

  const entries: Buffer[] = [];
  for (const bytes of [...encoded, ...rawComments]) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length, 0);
    entries.push(length, bytes);
  }

  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length / 2, 0);

  return Buffer.concat([vendorLength, vendorBytes, count, ...entries]);
}

/**
 * A FLAC stream carrying the given Vorbis comments.
 *
 * Built by hand rather than through the reader's own constants: a fixture that
 * borrowed them would agree with the reader about any mistake the two shared,
 * which is the same reason `cp1251` exists here as a second opinion.
 */
export function flac(
  options: {
    tags?: Record<string, string | string[]>;
    /** Whole `NAME=value` entries appended verbatim, bytes and all. */
    rawComments?: Buffer[];
    vendor?: string;
    sampleRate?: number;
    channels?: number;
    bitsPerSample?: number;
    totalSamples?: number;
  } = {},
): Buffer {
  const {
    tags = {},
    rawComments = [],
    vendor = 'reference libFLAC 1.4.3 20230623',
    sampleRate = 44100,
    channels = 2,
    bitsPerSample = 16,
    totalSamples = 44100,
  } = options;

  return Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    metadataBlock(0, streamInfoBody(sampleRate, channels, bitsPerSample, totalSamples), false),
    metadataBlock(4, vorbisCommentBody(tags, vendor, rawComments), true),
  ]);
}

/**
 * MPEG audio frames, built the way an encoder lays them out.
 *
 * Tables are written here independently of the reader, but note what that does
 * *not* buy: a builder and a reader sharing a wrong bitrate table would agree
 * with each other and both be wrong. The independent check on this parser is
 * ffprobe, and it now runs over the tables themselves rather than over one
 * layer's worth of them — `test/tools/mpeg-layers-vs-ffprobe.ts` builds a
 * stream of every version, layer and padding the reader knows and asks ffmpeg
 * to demux it, which puts the bitrate tables and the frame-length formula
 * against a second implementation. What is *not* second-opinioned is the
 * samples a frame carries; that tool says so where it matters.
 *
 * Every layer is written because every layer is *read*: the reader carries a
 * bitrate table, a samples-per-frame table and a frame-length formula for
 * Layers I and II, and until this fixture could write them, not one test
 * executed any of the three. That is how a wrong table survives a green suite —
 * the only layer the collection holds is III, so nothing else was ever asked
 * (task:2756, finding 11).
 */

/**
 * Bitrate in kbps by table index, keyed by rate family (`1` is MPEG-1, `2` is
 * MPEG-2 and MPEG-2.5, which share theirs) and then by layer.
 *
 * Transcribed column for column, and the columns are not alike: Layer I at
 * MPEG-1 runs to 448 and Layer III to 320, so a reader that read one layer
 * against the other's table would find a real bitrate at a real index and
 * report a track of the wrong length with nothing looking malformed.
 */
const BITRATES = {
  1: {
    I: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
    II: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
    III: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  },
  2: {
    I: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
    II: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    III: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  },
} as const;

/** Samples a frame carries, by rate family and layer. Layer III alone varies. */
const SAMPLES_PER_FRAME = {
  1: { I: 384, II: 1152, III: 1152 },
  2: { I: 384, II: 1152, III: 576 },
} as const;

const RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

/** The two-bit layer field, where **1 is Layer III** — the format's own ordering. */
const LAYER_FIELD = { III: 1, II: 2, I: 3 } as const;

export interface MpegOptions {
  /** 1 = MPEG-1, 2 = MPEG-2, 25 = MPEG-2.5. */
  version?: 1 | 2 | 25;
  /** The layer the frames are. Layer III unless a test says otherwise. */
  layer?: 'I' | 'II' | 'III';
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: 1 | 2;
  frames: number;
  /**
   * Set the padding bit on every frame.
   *
   * Not a knob for realism — a CBR encoder pads about nine frames in ten when
   * the frame size is not a whole number of bytes — but the only way to execute
   * the padding term at all. Off, every frame is the floor of the formula and
   * the bit could be ignored by the reader without a test noticing.
   */
  padding?: boolean;
  /** Write a LAME `Info`/`Xing`, or Fraunhofer's `VBRI`, into frame one. */
  header?: 'Info' | 'Xing' | 'VBRI' | null;
  /**
   * The count the header states, when it should differ from the frames written.
   *
   * The only way to tell a reader that trusts the header from one that walks and
   * finds the same number by luck: with the two equal, both answers are right.
   */
  headerFrames?: number;
  /** Bitrates per frame, for a VBR stream. Overrides `bitrateKbps`. */
  vbr?: number[];
}

export function mpeg(options: MpegOptions): Buffer {
  const {
    version = 1,
    layer = 'III',
    sampleRate = 44100,
    channels = 2,
    frames,
    header = null,
    vbr,
  } = options;

  // MPEG-2 and MPEG-2.5 are one family for every table there is.
  const family = version === 1 ? 1 : 2;
  const table = BITRATES[family][layer];
  const samplesPerFrame = SAMPLES_PER_FRAME[family][layer];
  const layerField = LAYER_FIELD[layer];
  const rateIndex = (RATES[version] as number[]).indexOf(sampleRate);
  if (rateIndex < 0) throw new Error(`no rate index for ${sampleRate} at MPEG-${version}`);

  const versionBits = version === 1 ? 3 : version === 2 ? 2 : 0;
  const channelBits = channels === 1 ? 3 : 0;
  const padded = options.padding === true ? 1 : 0;
  // Where a Xing/Info header would sit: right after the header and side info.
  const sideInfo = version === 1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;

  const out: Buffer[] = [];
  for (let index = 0; index < frames; index += 1) {
    const kbps = vbr?.[index] ?? options.bitrateKbps ?? 128;
    const bitrateIndex = (table as readonly number[]).indexOf(kbps);
    if (bitrateIndex <= 0) throw new Error(`no bitrate index for ${kbps} at MPEG-${version} Layer ${layer}`);

    // Two formulas, and the difference is not a detail: a Layer I frame counts
    // in four-byte slots and carries the padding as a whole slot, so a reader
    // that used the other one lands one frame in and stops.
    const frameSize =
      layerField === 3
        ? (Math.floor((12 * kbps * 1000) / sampleRate) + padded) * 4
        : Math.floor((samplesPerFrame / 8) * ((kbps * 1000) / sampleRate)) + padded;

    const frame = Buffer.alloc(frameSize);
    frame[0] = 0xff;
    // Bit 0 is the protection bit, and 1 is what says there is no CRC — the
    // opposite of what the bit's name suggests. Written as 0 it declares two
    // CRC bytes that are not there, which no reader here minds and a real
    // decoder does.
    frame[1] = 0xe0 | (versionBits << 3) | (layerField << 1) | 1;
    frame[2] = (bitrateIndex << 4) | (rateIndex << 2) | (padded << 1);
    frame[3] = channelBits << 6;

    if (index === 0 && header !== null) {
      const at = 4 + sideInfo;
      const stated = options.headerFrames ?? frames;
      if (header === 'VBRI') {
        // Fraunhofer's, which is longer than Xing's and puts the count further
        // in — and which no file in this collection carries, so nothing but
        // this fixture and the reader has ever seen one. The layout here was
        // settled by handing these bytes to ffmpeg and to the reader: both name
        // the same duration, and both read the same wrong one when the count is
        // moved. See the note on `framesFromHeader`.
        frame.write('VBRI', at, 'latin1');
        frame.writeUInt16BE(1, at + 4); // version
        frame.writeUInt16BE(0, at + 6); // delay
        frame.writeUInt16BE(0, at + 8); // quality
        frame.writeUInt32BE(frame.length * frames, at + 10); // bytes in the stream
        frame.writeUInt32BE(stated, at + 14); // frames
        frame.writeUInt16BE(0, at + 18); // table of contents entries
        frame.writeUInt16BE(1, at + 20); // scale
        frame.writeUInt16BE(2, at + 22); // entry size
      } else {
        frame.write(header, at, 'latin1');
        frame.writeUInt32BE(0x01, at + 4); // flags: frames present
        frame.writeUInt32BE(stated, at + 8);
      }
    }

    out.push(frame);
  }

  return Buffer.concat(out);
}

/**
 * MP4 atoms, laid out the way a tagger writes them.
 *
 * Same caveat as the MPEG builder above, and it bites harder here: box nesting
 * is easy to get plausible-looking and wrong, and a builder that mis-nests
 * agrees perfectly with a reader that mis-walks. The independent check is
 * ffprobe on real `.m4a` files — `format_tags` for the names, `-count_packets`
 * for the length.
 */

/** A box: four bytes of length, four of type, then the payload. */
function atom(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

/** The `data` box inside an `ilst` entry, which carries the type and the value. */
function dataAtom(typeIndicator: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(typeIndicator, 0);
  head.writeUInt32BE(0, 4); // locale
  return atom('data', Buffer.concat([head, payload]));
}

/** `trak.mdia.hdlr`, whose handler type is the only thing that says sound or picture. */
function hdlr(handlerType: string): Buffer {
  const body = Buffer.alloc(25);
  body.writeUInt32BE(0, 0); // version, flags
  body.writeUInt32BE(0, 4); // predefined
  body.write(handlerType, 8, 'latin1');
  return atom('hdlr', body);
}

/**
 * `esds` — the MPEG-4 elementary stream descriptor, which is where AAC says so.
 *
 * Only the two descriptors on the path to the object type are written: an
 * `ES_Descriptor` (tag 3) holding a `DecoderConfigDescriptor` (tag 4), whose
 * first byte is the object type indication. Lengths here are the one-byte form,
 * which is all a descriptor this short needs.
 */
function esds(objectType: number): Buffer {
  const decoderConfig = Buffer.from([
    0x04, 13, // tag, length
    objectType, // 0x40 is MPEG-4 audio, which for a `.m4a` is AAC
    0x15, // stream type: audio, and no upstream
    0, 0, 0, // buffer size
    0, 0, 0, 0, // max bitrate
    0, 0, 0, 0, // average bitrate
  ]);
  const es = Buffer.concat([
    Buffer.from([0x03, decoderConfig.length + 3, 0x00, 0x01, 0x00]), // tag, length, ES_ID, flags
    decoderConfig,
    Buffer.from([0x06, 0x01, 0x02]), // SLConfigDescriptor, which the format requires
  ]);
  return atom('esds', Buffer.concat([Buffer.alloc(4), es]));
}

/** The `stsd` entry naming one audio codec, as `codec` in `Mp4Options`. */
function sampleEntry(codec: string, channels: number, sampleRate: number): Buffer {
  const body = Buffer.alloc(28);
  body.writeUInt16BE(1, 6); // data reference index
  body.writeUInt16BE(channels, 16);
  body.writeUInt16BE(16, 18); // sample size
  // The sample rate is a 16.16 fixed number, so the integer half is the rate.
  body.writeUInt32BE(sampleRate * 65_536, 24);

  // The four-character code is the sample entry's own type, and for `mp4a` it is
  // not the whole answer: the object type inside `esds` is what says AAC.
  const children = codec === 'mp4a' ? esds(0x40) : Buffer.alloc(0);
  return atom(codec, Buffer.concat([body, children]));
}

/** `minf.stbl.stsd`, reached only through a sound track's `mdia`. */
function stbl(codec: string, channels: number, sampleRate: number): Buffer {
  const stsd = atom('stsd', Buffer.concat([
    Buffer.alloc(4), // version, flags
    Buffer.from([0, 0, 0, 1]), // one entry
    sampleEntry(codec, channels, sampleRate),
  ]));
  return atom('stbl', stsd);
}

export type Mp4TagValue = string | [number, number];

export interface Mp4Options {
  /** `©nam`, `©ART`, `aART`, `©alb`, `©gen`, `©day` — text, in UTF-8. */
  tags?: Record<string, string | string[]>;
  /**
   * The same atoms with their bytes handed over verbatim, still under the type
   * indicator that declares them UTF-8.
   *
   * The only way to build the case that matters: a value written in CP1251 by a
   * tagger that declared it UTF-8 anyway. `tags` cannot express it — it encodes
   * every value as UTF-8, which is exactly the claim under test.
   */
  rawTags?: Record<string, Buffer[]>;
  /** `trkn` / `disk`, written as the binary pair the format actually uses. */
  numbers?: Record<string, [number, number]>;
  /**
   * `gnre` — the ID3v1 genre list by number, **one-based**, which is how iTunes
   * writes a genre it took from that list instead of writing `©gen` in words.
   */
  id3Genres?: number[];
  /**
   * Atoms holding one number — `rtng`, iTunes' content rating.
   *
   * One byte and a data type of its own, which is why neither `numbers` nor
   * `id3Genres` can stand in: the first writes a pair, the second writes a
   * genre-list index, and this is the value itself.
   */
  integers?: Record<string, number>;
  /** `moov.mvhd` timescale. 44100 by default, as an audio track would carry. */
  timescale?: number;
  /**
   * Length in timescale units; ten seconds unless a test says otherwise.
   *
   * Written as 0 when `fragmented`. The default is a real length rather than
   * zero, so a test about tags still exercises the length beside them.
   */
  duration?: number;
  /** A fragmented file states no length in `mvhd`, and must not claim one. */
  fragmented?: boolean;
  /** Leave out `moov` entirely — a download that stopped before the index. */
  withoutMoov?: boolean;
  /** Put `moof`/`mdat` before `moov`, which is where a fragmented file puts them. */
  fragmentsFirst?: boolean;
  /** An entry whose value is an image. Must never surface as a tag. */
  cover?: boolean;
  /**
   * Handler types of the tracks, defaulting to sound alone.
   *
   * This is the only thing in an MP4 that distinguishes a song from a video —
   * the extension does not, and a phone clip and an `.m4a` are the same
   * container with the same `ftyp`. A live clip is `['soun', 'vide']`.
   */
  tracks?: string[];
  /**
   * The four-character code of the sound track's sample description, or none.
   *
   * `mp4a` is AAC and `alac` is Apple Lossless, and this is the only place in
   * the file that names which — which is why the decision path used to spawn
   * ffprobe for all 1425 `.m4a` of the collection (task:2910). Anything else is
   * written verbatim, so a test can hand the reader a code it must decline to
   * name rather than guess at.
   */
  codec?: string;
  /**
   * What the sample entry above says the audio is, when it says anything.
   *
   * Both live in the same fixed header as the codec, which is why a reader that
   * walks as far as one has the other two for nothing.
   */
  channels?: number;
  sampleRate?: number;
}

export function mp4(options: Mp4Options = {}): Buffer {
  const {
    tags = {},
    numbers = {},
    timescale = 44100,
    duration = 441_000,
    cover = false,
  } = options;

  const entries: Buffer[] = [];
  for (const [name, value] of Object.entries(tags)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      entries.push(atom(name, dataAtom(1, Buffer.from(one, 'utf8'))));
    }
  }
  for (const [name, payloads] of Object.entries(options.rawTags ?? {})) {
    for (const payload of payloads) entries.push(atom(name, dataAtom(1, payload)));
  }
  for (const [name, [first, total]] of Object.entries(numbers)) {
    const body = Buffer.alloc(8);
    body.writeUInt16BE(first, 2);
    body.writeUInt16BE(total, 4);
    entries.push(atom(name, dataAtom(0, body)));
  }
  for (const index of options.id3Genres ?? []) {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(index, 0);
    entries.push(atom('gnre', dataAtom(0, body)));
  }
  for (const [name, value] of Object.entries(options.integers ?? {})) {
    // Type 21 is the integer one, and the payload is the byte itself.
    entries.push(atom(name, dataAtom(21, Buffer.from([value & 0xff]))));
  }
  if (cover) {
    // Type 13 is JPEG. The reader must step over it by size, not decode it.
    entries.push(atom('covr', dataAtom(13, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))));
  }

  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(0, 0); // version 0, flags 0
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(options.fragmented === true ? 0 : duration, 16);

  const moov = atom(
    'moov',
    Buffer.concat([
      atom('mvhd', mvhd),
      ...(options.tracks ?? ['soun']).map((handler) => atom('trak', atom('mdia', Buffer.concat([
        hdlr(handler),
        // Only a sound track carries a sample description this fixture can
        // build, and a picture track's would say nothing about the audio.
        handler === 'soun' && options.codec !== undefined
          ? atom('minf', stbl(options.codec, options.channels ?? 2, options.sampleRate ?? 44_100))
          : Buffer.alloc(0),
      ])))),
      atom('udta', atom('meta', Buffer.concat([Buffer.alloc(4), atom('ilst', Buffer.concat(entries))]))),
    ]),
  );

  const ftyp = atom('ftyp', Buffer.from('M4A 00000000M4A mp42isom', 'latin1'));
  if (options.withoutMoov === true) return ftyp;

  const fragments = [atom('moof', Buffer.alloc(8)), atom('mdat', Buffer.alloc(8))];
  return options.fragmentsFirst === true
    ? Buffer.concat([ftyp, ...fragments, moov])
    : Buffer.concat([ftyp, moov, ...fragments]);
}

/**
 * A picture block, as RFC 9639 section 8.8 lays one out.
 *
 * Built here because two formats carry it and the layout is fiddly in a way that
 * a reader and a builder written by the same hand can agree on and both get
 * wrong: a type, a length-prefixed MIME string, a length-prefixed description,
 * four dimension words, then a length-prefixed image. The description is the
 * field that catches readers out — it is arbitrary text of arbitrary length, so
 * a parser that trusted the first two lengths points into the middle of a
 * caption.
 *
 * A FLAC file carries this block as metadata block 6; an Ogg file carries it
 * base64'd inside a `METADATA_BLOCK_PICTURE` comment, which is what an Ogg
 * *can* do, having no metadata block to put one in.
 */
export function pictureBlock(options: {
  kind?: number;
  mime?: string;
  description?: string;
  data?: Buffer;
} = {}): Buffer {
  const {
    kind = 3, // front cover, the type that means "this is it"
    mime = 'image/jpeg',
    description = '',
    data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  } = options;

  const mimeBytes = Buffer.from(mime, 'latin1');
  const described = Buffer.from(description, 'utf8');

  const head = Buffer.alloc(8);
  head.writeUInt32BE(kind, 0);
  head.writeUInt32BE(mimeBytes.length, 4);

  const mimeLength = Buffer.alloc(4);
  mimeLength.writeUInt32BE(mimeBytes.length, 0);
  const descriptionLength = Buffer.alloc(4);
  descriptionLength.writeUInt32BE(described.length, 0);
  const dataLength = Buffer.alloc(4);
  dataLength.writeUInt32BE(data.length, 0);

  return Buffer.concat([
    head,
    mimeBytes,
    descriptionLength,
    described,
    Buffer.alloc(16), // width, height, colour depth, colours — all unstated
    dataLength,
    data,
  ]);
}

/**
 * Ogg pages and streams, built the way a muxer builds them.
 *
 * Same caveat as the MPEG and MP4 builders above, and it applies hardest here:
 * an Ogg page is a header, a segment table and a body whose boundary is the
 * *sum of the table*, so a builder that lays pages out wrong produces a stream
 * that is plausible and unreadable — and a reader written from the same
 * misunderstanding walks it happily. The independent check is a real `.ogg`
 * file: the CRC this computes has to match the one a real encoder wrote, and
 * `test/tools` is where that comparison lives.
 */

/**
 * Ogg's CRC-32, which is **not** the CRC-32 most tools mean.
 *
 * RFC 3533 §6, field 7 names the generator polynomial 0x04c11db7 and the page
 * it covers: "the page (including header with zero CRC field and page content)".
 * What the RFC does not spell out, and what every wrong implementation gets
 * wrong, is that this checksum is *not reflected* — each byte is fed in from its
 * high bit, where zlib's CRC-32 (and the one in a PNG) reverses the bits of
 * every byte first. The two agree on nothing.
 *
 * The initial value is zero and the result is not inverted at the end. Both are
 * stated by libogg's `crc_lookup` table rather than by the RFC, which names only
 * the polynomial; a page whose checksum was computed with a different initial
 * value is a page a real decoder rejects.
 */
const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 0x8000_0000) !== 0 ? ((value << 1) ^ 0x04c1_1db7) >>> 0 : (value << 1) >>> 0;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** The checksum RFC 3533 §6 puts at bytes 22..25 of every page. */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ (OGG_CRC_TABLE[(crc >>> 24) ^ byte] as number)) >>> 0;
  }
  return crc >>> 0;
}

/** `-1` in two's complement: the granule of a page no packet finishes on. */
const NO_GRANULE = -1n;

/**
 * One page: a 27-byte header, the segment table, then the body.
 *
 * RFC 3533 §6 gives the layout, and the arithmetic worth repeating is that the
 * header is `number_page_segments + 27` bytes — the segment count is *inside*
 * the fixed part and the table is not. The CRC covers the finished page with
 * its own four bytes left at zero, which is why it is written last.
 */
function oggPage(options: {
  serial: number;
  sequence: number;
  granule: bigint;
  headerType: number;
  segments: number[];
  body: Buffer;
}): Buffer {
  const header = Buffer.alloc(27 + options.segments.length);
  header.write('OggS', 0, 'latin1');
  header[4] = 0; // stream structure version, which this document defines as 0
  header[5] = options.headerType;
  header.writeBigInt64LE(options.granule, 6);
  header.writeUInt32LE(options.serial >>> 0, 14);
  header.writeUInt32LE(options.sequence, 18);
  header.writeUInt32LE(0, 22); // the CRC's own field, zero for the computation
  header[26] = options.segments.length;
  options.segments.forEach((value, index) => {
    header[27 + index] = value;
  });

  const page = Buffer.concat([header, options.body]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/** `header_type_flag` bits (RFC 3533 §6, field 3). */
const CONTINUED = 0x01;
const BEGINNING = 0x02;
const END = 0x04;

/**
 * Packets into pages, by the lacing rule of RFC 3533 §5.
 *
 * The rule, which is the whole of Ogg's framing: a packet is cut into segments
 * of at most 255 bytes and the packet is *finished* by a segment shorter than
 * 255. So a segment of exactly 255 means "more of this packet follows" — on
 * this page or, if the page runs out of segment slots, on the next one, whose
 * first segment continues it.
 *
 * Two cases fall out of that and neither is obvious:
 *
 *   - a packet whose length is a multiple of 255 needs a **zero-length
 *     terminator** segment to end it. Without one the last full segment would
 *     read as a continuation, and the packet would swallow whatever follows.
 *   - a page that runs out mid-packet has a granule position of **-1**, not of
 *     the samples before it: §6 says the field is "set to the special value of
 *     -1" when no packets finish on the page. Writing the running total there
 *     would tell a reader that a page which completes nothing has completed
 *     something.
 */
function packPages(
  packets: Buffer[],
  options: {
    serial: number;
    firstSequence: number;
    /** Segment slots a page may use. 255 is the format's own ceiling. */
    segmentsPerPage: number;
    /** The granule a page carries when it *does* finish a packet. */
    granuleOf: (pageIndex: number, lastPacket: number) => bigint;
    /** The first page of the stream, which is flagged `bos`. */
    beginning?: boolean;
  },
): Buffer[] {
  const pages: Buffer[] = [];
  let sequence = options.firstSequence;
  let packetIndex = 0;
  let offset = 0;
  // Whether the last segment of the previous page left a packet unfinished —
  // which is what the `continued` bit of the next page's header states.
  let carried = false;

  while (packetIndex < packets.length) {
    const segments: number[] = [];
    const chunks: Buffer[] = [];
    const startedCarrying = carried;
    carried = false;

    while (segments.length < options.segmentsPerPage && packetIndex < packets.length) {
      const packet = packets[packetIndex] as Buffer;
      const remaining = packet.length - offset;

      if (remaining >= 255) {
        segments.push(255);
        chunks.push(packet.subarray(offset, offset + 255));
        offset += 255;

        if (offset < packet.length) continue;
        if (segments.length < options.segmentsPerPage) {
          segments.push(0); // the terminator case above
          packetIndex += 1;
          offset = 0;
          continue;
        }
        // The page filled exactly on the boundary, so the terminating zero has
        // no slot here and the packet ends on the next page instead.
        carried = true;
        continue;
      }

      segments.push(remaining);
      chunks.push(packet.subarray(offset));
      packetIndex += 1;
      offset = 0;
    }

    // A page whose last lacing value is 255 leaves its last packet open. That is
    // the same statement as the granule: §6 sets the field to -1 exactly when no
    // packet finishes on the page.
    if (segments[segments.length - 1] === 255) carried = true;

    pages.push(
      oggPage({
        serial: options.serial,
        sequence,
        granule: carried ? NO_GRANULE : options.granuleOf(pages.length, packetIndex - 1),
        headerType:
          (options.beginning === true && pages.length === 0 ? BEGINNING : 0) |
          (startedCarrying ? CONTINUED : 0),
        segments,
        body: Buffer.concat(chunks),
      }),
    );
    sequence += 1;
  }

  return pages;
}

/**
 * The six octets every Vorbis header packet carries after its type octet.
 *
 * Written as a byte list rather than as `'\x05vorbis'`: a control character in a
 * source file is invisible, survives review, and turns the file binary for every
 * tool that reads it. `text/encoding.ts` makes the same argument about regex
 * literals holding raw controls.
 */
const VORBIS_MAGIC = [0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]; // 'vorbis'

/** The identification packet, as Vorbis I §4.2.2 codes it. */
function vorbisIdentification(sampleRate: number, channels: number): Buffer {
  const body = Buffer.alloc(30);
  body[0] = 0x01; // packet type 1
  body.write('vorbis', 1, 'latin1');
  body.writeUInt32LE(0, 7); // vorbis_version
  body[11] = channels;
  body.writeUInt32LE(sampleRate, 12);
  // bitrate maximum, nominal and minimum follow, all zero: §4.2.2 says an
  // encoder may leave any of them unstated, and a reader that needed them to
  // find the sample rate would be reading the wrong field anyway.
  // §4.2.2 packs two four-bit *exponents*, not two sizes, and §2.1.4 packs a
  // field least-significant bit first: blocksize_0 is read first and so lands in
  // the **low** nibble, blocksize_1 in the high one, each read as 2^n. So 0x08
  // would say blocksize_0 = 2^8 = 256 and blocksize_1 = 2^0 = 1 sample — below
  // the 64 the section allows — and a real decoder refuses the file: measured,
  // ffprobe read this fixture as "Header processing failed" until the byte was
  // 0xb8, and only then could it get far enough to complain about the setup
  // header, which is the one part of this fixture that is deliberately not
  // decodable. A fixture no decoder will open cannot say its own header is right.
  body[28] = 0xb8; // blocksize_0 = 2^8 = 256 (low nibble), blocksize_1 = 2^11 = 2048 (high)
  body[29] = 0x01; // framing bit
  return body;
}

/** The identification packet, as RFC 7845 §5.1 codes it. */
function opusIdentification(preSkip: number, channels: number, inputRate: number): Buffer {
  const body = Buffer.alloc(19);
  body.write('OpusHead', 0, 'latin1');
  body[8] = 1; // version
  body[9] = channels;
  body.writeUInt16LE(preSkip, 10);
  body.writeUInt32LE(inputRate, 14);
  // Output gain and mapping family stay zero — family 0, which is mono or
  // stereo and states nothing further.
  return body;
}

/**
 * A comment header body: the vendor string, then the list (Vorbis I §5.2.1,
 * which RFC 7845 §5.2 reuses for Opus with the framing bit left off).
 */
function commentBody(
  tags: Record<string, string | string[]>,
  vendor: string,
  rawComments: Buffer[],
): Buffer {
  const encoded: Buffer[] = [];
  for (const [name, value] of Object.entries(tags)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      encoded.push(Buffer.from(`${name}=${one}`, 'utf8'));
    }
  }

  const vendorBytes = Buffer.from(vendor, 'utf8');
  const vendorLength = Buffer.alloc(4);
  vendorLength.writeUInt32LE(vendorBytes.length, 0);

  const entries: Buffer[] = [];
  for (const bytes of [...encoded, ...rawComments]) {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length, 0);
    entries.push(length, bytes);
  }

  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length / 2, 0);

  return Buffer.concat([vendorLength, vendorBytes, count, ...entries]);
}

export interface OggOptions {
  /** Which of the two codecs the stream declares. `vorbis` unless said otherwise. */
  codec?: 'vorbis' | 'opus';
  tags?: Record<string, string | string[]>;
  /** Whole `NAME=value` entries appended verbatim, bytes and all. */
  rawComments?: Buffer[];
  /**
   * A cover the stream carries as a `METADATA_BLOCK_PICTURE` comment.
   *
   * The only way an Ogg file holds one: the container has no metadata block, so
   * the convention is to base64 a FLAC picture block into a comment. Written as
   * a comment rather than as a separate structure because that is what it is —
   * a reader that treats it as a tag stores a hundred and eighty kilobytes of
   * base64 where a title goes.
   */
  picture?: { kind?: number; mime?: string; description?: string; data?: Buffer };
  vendor?: string;
  /** The identification header's own rate. Vorbis only — Opus plays at 48 kHz. */
  sampleRate?: number;
  /** What an Opus ID header says the audio was *before* encoding. */
  inputSampleRate?: number;
  channels?: number;
  /**
   * The length the last page states, in the codec's own units: PCM samples for
   * Vorbis, 48 kHz samples for Opus (RFC 7845 §4).
   */
  granule?: number;
  /** Opus pre-skip (RFC 7845 §5.1), which the granule counts before it. */
  preSkip?: number;
  /** How many pages the audio is spread over. The last one carries `granule`. */
  audioPages?: number;
  /**
   * Segment slots a page may hold, 255 by default.
   *
   * The knob that makes a header packet span pages without a megabyte of
   * fixture: at 4 slots, both the comment and the setup header cross a page
   * boundary the way a real encoder's do.
   */
  segmentsPerPage?: number;
  serial?: number;
  /** Splice a second logical stream's pages in — a multiplexed file. */
  interleave?: boolean;
  /** Stop after the headers: no audio pages at all. */
  withoutAudio?: boolean;
}

/**
 * An Ogg stream carrying the given comments, laid out as a real one is.
 *
 * Vorbis I §A.2 states the shape being reproduced here: the identification
 * packet sits **alone** on the first page (which is why a Vorbis file opens
 * with a page of exactly 58 bytes), the comment and setup packets follow on the
 * pages after it, and the first audio packet begins a fresh page. RFC 7845 §3
 * says the same of Opus, whose three header packets are likewise its own.
 *
 * The audio pages exist for the granule position and nothing else: this reader
 * never decodes a packet, and the length of a Vorbis or Opus file is a number
 * the *last page states* rather than one that has to be arrived at.
 */
export function ogg(options: OggOptions = {}): Buffer {
  const {
    codec = 'vorbis',
    tags = {},
    rawComments = [],
    vendor = codec === 'opus' ? 'libopus 1.4' : 'Xiph.Org libVorbis I 20200704',
    sampleRate = 44100,
    inputSampleRate = 44100,
    channels = 2,
    preSkip = 312,
    audioPages = 3,
    segmentsPerPage = 255,
    serial = 0x5eed_1234,
    interleave = false,
    withoutAudio = false,
  } = options;

  const isOpus = codec === 'opus';
  const granule = BigInt(options.granule ?? sampleRate * 3);

  const identification = isOpus
    ? opusIdentification(preSkip, channels, inputSampleRate)
    : vorbisIdentification(sampleRate, channels);

  // Vorbis I §4.2.1: a header packet opens with a type octet — 1 for the
  // identification header, 3 for the comment, 5 for the setup — followed by the
  // six octets `vorbis`. Opus has no such octet: RFC 7845 §5 names its two
  // headers by a magic signature instead, and a stream has only the two of them.
  const comment = Buffer.concat([
    isOpus ? Buffer.from('OpusTags', 'latin1') : Buffer.from([0x03, ...VORBIS_MAGIC]),
    commentBody(
      tags,
      vendor,
      // The cover goes in with the raw entries: it is one more `NAME=value`, and
      // the value happens to be a base64 picture block. Nothing here marks it as
      // special, and nothing should — the reader is what has to know.
      options.picture === undefined
        ? rawComments
        : [
            ...rawComments,
            Buffer.from(
              `METADATA_BLOCK_PICTURE=${pictureBlock(options.picture).toString('base64')}`,
              'latin1',
            ),
          ],
    ),
    // §5.2.1 finishes the Vorbis comment packet with a framing bit, and RFC 7845
    // §5.2 is explicit that Opus leaves it off. A reader that takes the stated
    // number of comments never has to look at it — which is exactly why it is
    // written here: a fixture that leaned on it would be testing its own bug.
    isOpus ? Buffer.alloc(0) : Buffer.from([0x01]),
  ]);

  // Opus has no setup header: RFC 7845 §3 makes the stream exactly two header
  // packets and then audio. Vorbis I §4.2.1 makes it three.
  const headerPackets = isOpus
    ? [comment]
    : [comment, Buffer.concat([Buffer.from([0x05, ...VORBIS_MAGIC]), Buffer.alloc(900, 0x7f)])];
  // Packet one alone on the beginning-of-stream page — §A.2's own arrangement.
  const first = packPages([identification], {
    serial,
    firstSequence: 0,
    segmentsPerPage,
    beginning: true,
    granuleOf: () => 0n, // §A.2: header-only pages state a granule of zero
  });

  const headers = packPages(headerPackets, {
    serial,
    firstSequence: first.length,
    segmentsPerPage,
    granuleOf: () => 0n, // §A.2: the pages carrying only headers state a granule of zero
  });

  const pages = [...first, ...headers];

  if (!withoutAudio && audioPages > 0) {
    // One packet per audio page, with the running total stated on each. The
    // granules are spread so that the *last* page's is the one the caller asked
    // for: a reader that took the first page's would report a third of the song.
    const bodies: Buffer[] = [];
    const granules: bigint[] = [];
    for (let index = 0; index < audioPages; index += 1) {
      bodies.push(Buffer.alloc(120, 0x00));
      granules.push(audioPages === 1 ? granule : (granule * BigInt(index + 1)) / BigInt(audioPages));
    }
    granules[audioPages - 1] = granule;

    const audio = packPages(bodies, {
      serial,
      firstSequence: pages.length,
      // One packet per page, and not the caller's page size: a granule is a
      // statement about the last packet a page *finishes*, so an audio page
      // holding three packets would state the sum of all three and the caller's
      // `granule` would land on whichever page held the last of them. Real
      // encoders pack audio pages densely; this fixture deliberately does not,
      // because each page's granule is the thing under test.
      segmentsPerPage: 1,
      granuleOf: (pageIndex) => granules[pageIndex] ?? granule,
    });
    pages.push(...audio);

    // The last page of the logical stream is flagged `end of stream`, which is
    // how a reader knows it has reached the end rather than been cut short.
    const last = pages[pages.length - 1] as Buffer;
    last[5] = (last[5] as number) | END;
    // The field has to be zeroed before it is computed, not merely overwritten
    // after: the checksum covers the whole page *including* these four bytes, so
    // computing it over the page that already carries a checksum hashes the old
    // value into the new one and no decoder on earth accepts the result.
    last.writeUInt32LE(0, 22);
    last.writeUInt32LE(oggCrc(last), 22);
  }

  if (interleave) {
    // A second logical stream's pages. RFC 3533 §6 numbers pages per logical
    // bitstream, so splicing whole pages of another serial in is exactly how a
    // real muxer interleaves audio with a video track — and it is the case a
    // reader that ignored the serial number would read the wrong packets from.
    const other = packPages([Buffer.alloc(40, 0xaa)], {
      serial: serial + 1,
      firstSequence: 0,
      segmentsPerPage,
      beginning: true,
      granuleOf: () => 0n,
    });
    return Buffer.concat([pages[0] as Buffer, ...other, ...pages.slice(1)]);
  }

  return Buffer.concat(pages);
}

/**
 * An ID3v1 tag: 128 bytes that live at the very end of an MPEG file.
 *
 * Built to the layout the format's own author writes in the conformance suite's
 * `generate.pike` — the `ID3_1` and `ID3_11` classes, which are the format
 * stated as data. There is no RFC to cite here and the suite's README says so:
 * ID3v1 "is not formally standardized". That makes a fixture more dangerous than
 * usual, not less — a builder and a reader written from the same guess agree
 * with each other about a format neither has a text for — so the fields below
 * are laid out in the generator's order and widths, and the suite itself is what
 * settles whether the reading is right.
 *
 * The two versions differ only in the comment: v1.0 gives it the full thirty
 * bytes, v1.1 spends the last two on a zero byte and a track number — which is
 * why the fixture writes the zero, and why a file with a track of zero is
 * indistinguishable from an untracked v1.0 tag.
 */
export function id3v1(
  options: {
    /** The three magic bytes. Wrong case is a suite case, and must not be read. */
    head?: string;
    version?: '1.0' | '1.1';
    title?: string;
    artist?: string;
    album?: string;
    year?: string;
    comment?: string;
    track?: number;
    genre?: number;
    /**
     * A field's bytes written verbatim, padded to the field's width with NULs.
     *
     * The only way to build what the named fields cannot say: a year of `"   3"`
     * or one full of NULs, or a title in a code page the string form would not
     * choose. Same argument as `rawComments` on `flac()` — the shape under test
     * is the one the convenient form cannot express.
     */
    raw?: Partial<Record<'title' | 'artist' | 'album' | 'year' | 'comment', Buffer>>;
  } = {},
): Buffer {
  const version = options.version ?? '1.0';
  const tracked = version === '1.1';

  // Throws where the suite's own generator throws, rather than truncating. A
  // field longer than its width is a mistake in the test that asked for it, and
  // it is the quiet kind: a silently shortened album name still builds a valid
  // tag, so the test passes while asserting against a string nobody wrote. This
  // fixture truncated until a test lost `...Has` to `...Ha` and the failure
  // looked like a reader bug for a minute.
  const pad = (bytes: Buffer, width: number): Buffer => {
    if (bytes.length > width) {
      throw new Error(`a field of ${width} bytes cannot hold ${bytes.length}: ${JSON.stringify(bytes.toString('latin1'))}`);
    }
    return Buffer.concat([bytes, Buffer.alloc(width - bytes.length)]);
  };

  const field = (name: 'title' | 'artist' | 'album' | 'year' | 'comment', value: string | undefined, width: number): Buffer =>
    pad(options.raw?.[name] ?? Buffer.from(value ?? '', 'latin1'), width);

  const tag = Buffer.concat([
    Buffer.from(options.head ?? 'TAG', 'latin1'),
    field('title', options.title, 30),
    field('artist', options.artist, 30),
    field('album', options.album, 30),
    field('year', options.year ?? '2003', 4),
    field('comment', options.comment, tracked ? 28 : 30),
    // The v1.1 zero byte, then the track — the generator's `null` and `track`.
    ...(tracked ? [Buffer.from([0, options.track ?? 0])] : []),
    Buffer.from([options.genre ?? 0]),
  ]);

  // 3 + 30 + 30 + 30 + 4 + (30 | 28 + 1 + 1) + 1 = 128, which is not a detail:
  // the block is found by counting back from the end of the file.
  if (tag.length !== 128) throw new Error(`an ID3v1 tag is 128 bytes, this is ${tag.length}`);
  return tag;
}
