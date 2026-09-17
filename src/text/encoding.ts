/**
 * Bytes to text, with the reasoning written down.
 *
 * The collection is ~50k files ripped by whoever, whenever, and the text side
 * of it is a mess: cue sheets in CP1251, tags that declare Latin-1 over Russian
 * bytes, `.nfo` files from the DOS era. Getting this wrong does not throw — it
 * produces plausible-looking mojibake (`CafЙ`, `Ïðèâåò`) that flows silently
 * into album titles.
 *
 * So this module never returns a bare string. It returns the text *and* the
 * encoding it decided on, how sure it is, and the reason — because the contract
 * forbids losing information silently (requirements:39), and "I guessed CP1251"
 * is information.
 *
 * Files are never rewritten. Everything here is an overlay: the bytes on disk
 * stay exactly as they were.
 *
 * All three entry points have callers. `decodeText` serves the scanner's cue
 * sheets; `decodeVorbisText` and `decodeId3Text` serve the tag readers
 * (`tags/flac.ts`, `tags/id3v2.ts`), which write what they decide into
 * `file.encoding` and `file.encoding_confidence` and report an inference that
 * was not certain. Nothing reads `.nfo`/`.log` sidecars yet.
 */

/**
 * The confidence reported when the detector had nothing to infer: a byte-order
 * mark, or content every candidate encoding agrees on. Anything below this is
 * an inference the caller should be willing to log.
 */
export const CERTAIN = 1;

/**
 * At or above this, an inference is well-founded enough to record as
 * information rather than as a warning.
 */
export const CONFIDENT = 0.75;

/**
 * `windows-1252`, not `iso-8859-1`, and the difference is not pedantry.
 *
 * The design spec says "CP1251-vs-Latin-1", but Latin-1 has no printable
 * characters in `0x80..0x9F` — a Western rip containing a curly quote or an em
 * dash is CP1252, which is what Windows actually writes. The two agree on
 * `0xA0..0xFF`, which is the whole range that matters for prose, so nothing is
 * lost by naming the family after the code page people really use. Node agrees:
 * `new TextDecoder('latin1').encoding === 'windows-1252'`.
 */
export type EncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251' | 'windows-1252';

/** Text, the encoding it was read as, and how that call was reached. */
export interface DecodedText {
  text: string;
  encoding: EncodingName;
  /**
   * `CERTAIN` when nothing was inferred; below it, the caller has a guess to
   * report.
   *
   * The scale is deliberately coarse. It separates a declaration from a
   * coin-flip from a well-founded inference, and does not try to rank one
   * inference against another:
   *
   *   1.00        a BOM, or content every candidate encoding agrees on
   *   0.85 – 0.90 a strong single-byte verdict: a long Cyrillic run, or no
   *               high bytes to argue about at all
   *   0.70 – 0.75 a real but shorter Cyrillic run, or a verdict reached against
   *               thin evidence
   *   0.50 – 0.60 a fallback taken because the better reading was unavailable
   *               (no BOM on UTF-16; a decode whose text is mostly controls)
   */
  confidence: number;
  /** Why the detector decided as it did — goes straight into the issue log. */
  basis: string;
}

/**
 * A run of consecutive bytes in `0xC0..0xFF` at least this long is Cyrillic.
 *
 * Both code pages fill that range — CP1251 with А-я, CP1252 with À-ÿ — so the
 * bytes really are the same bytes. What differs is the *shape* of the text that
 * produced them: Cyrillic is written in words, and a Russian word arrives as a
 * run of letters from the range (`Последний` is nine bytes in a row), whereas
 * accented Latin is written one letter at a time (`café`, `déjà`, `Ça` — never
 * two accented letters adjacent).
 *
 * Density was tried first, and it is not enough. A real EAC log from the
 * collection is 700-odd ASCII letters of English boilerplate with one Russian
 * line near the top: Cyrillic is 4% of its letters, so every share-based
 * threshold calls it Western and hands back `Êèíî / Ïîñëåäíèé ãåðîé`. The run
 * rule is blind to that ratio — the words are just as long either way.
 *
 * Three, not two: Spanish opens with `¡Él`, which puts two high bytes in a row
 * with no Cyrillic anywhere near it.
 */
const MIN_CYRILLIC_RUN = 3;

/** Shorter than this, a text is too small to call "mostly" anything. */
const CONTROL_SAMPLE = 8;

/** Above this share of control characters, the text is not really text. */
const CONTROL_SHARE = 0.05;

/**
 * Does the text contain C1 controls, U+0080..U+009F?
 *
 * Written as a loop rather than a character-class regex on purpose: the range
 * is invisible in source, and a regex literal holding raw control characters is
 * one editor round-trip away from silently matching the wrong thing.
 *
 * A real document never contains them — only a broken re-encode does.
 */
function hasC1Controls(text: string): boolean {
  for (const ch of text) {
    const point = ch.codePointAt(0) as number;
    if (point >= 0x80 && point <= 0x9f) return true;
  }
  return false;
}

/**
 * Drop trailing U+0000 characters.
 *
 * ID3 text is NUL-terminated, and doing this on the byte array is wrong the
 * moment the encoding is 16-bit: `'AB\0'` in UTF-16LE is `41 00 42 00 00 00`,
 * a byte-wise strip eats three bytes and leaves `41 00 42`, and the decoder
 * turns that odd length into `A�` — a silent character loss on any value
 * ending in an ASCII letter. Character-domain stripping cannot split a code
 * unit, so it is correct at every width without special-casing any.
 */
function stripTrailingNulChars(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0) end -= 1;
  return text.slice(0, end);
}

/**
 * Is the text mostly control characters?
 *
 * This is the signature of UTF-16 read as UTF-8, which validates perfectly and
 * is pure garbage. ASCII in UTF-16LE is letters separated by NULs; Cyrillic in
 * UTF-16LE is letters interleaved with the high byte (U+041F arrives as
 * `1f 04`), so either way half the "text" is controls.
 *
 * A ratio rather than "any control at all": a stray byte in an otherwise fine
 * cue is noise, not evidence, and flagging it would cry wolf on every scan.
 */
function isMostlyControls(text: string): boolean {
  // Judged without the terminator: a NUL-terminated `Аквариум` is nine
  // characters of which one is padding, and counting that padding as evidence
  // of "mostly controls" would flag every well-formed ID3 frame.
  const body = stripTrailingNulChars(text);
  if (body.length < CONTROL_SAMPLE) return false;

  let controls = 0;
  for (const ch of body) {
    const point = ch.codePointAt(0) as number;
    const benign = point === 0x09 || point === 0x0a || point === 0x0d;
    if (!benign && (point < 0x20 || (point >= 0x7f && point <= 0x9f))) controls += 1;
  }

  return controls / body.length > CONTROL_SHARE;
}

/**
 * Could this be text a person wrote?
 *
 * Exported because the parsers have to make the same judgement the decoder
 * makes, and there should be one definition of "this is not text" rather than
 * two that can drift. A tag value whose bytes are mostly control characters is
 * not a value: storing it puts a control character where a title belongs, and
 * splitting it on the NULs it is full of turns one broken frame into a dozen
 * one-character tags that then outrank a readable folder name.
 */
export function looksLikeText(text: string): boolean {
  return !isMostlyControls(text);
}

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const BOM_UTF16LE = [0xff, 0xfe];
const BOM_UTF16BE = [0xfe, 0xff];

/** A fresh decoder per call: `fatal` throws, and state must not leak between calls. */
function decodeAs(encoding: EncodingName, bytes: Uint8Array): string {
  return new TextDecoder(encoding).decode(bytes);
}

/** Strict UTF-8, or null. `fatal` is what turns "looks close enough" into a real answer. */
function tryUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes[i] === byte);
}

function hasHighByte(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte >= 0x80) return true;
  return false;
}

/**
 * The UTF-8 reading of a body that claims to be UTF-8, or null if it is not.
 *
 * Shared by all three entry points because the check has to be the same in each
 * of them — a body that validates but decodes to control characters is exactly
 * the case that must not be reported as certain, and having that rule in one
 * place is what stops it from being applied in one place out of three.
 *
 * `basis` names the claim being tested, so the reason reads correctly whether
 * it came from a Vorbis comment, an ID3v2 frame, or no declaration at all.
 */
function fromUtf8(bytes: Uint8Array, basis: string): DecodedText | null {
  const text = tryUtf8(bytes);
  if (text === null) return null;

  // Bytes 0x80..0x9F are not valid UTF-8 on their own, so their arriving as
  // U+0080..U+009F means someone encoded a Windows code page *as* Latin-1 and
  // then as UTF-8. The text decodes, and it is still wrong.
  if (hasC1Controls(text)) {
    return {
      text,
      encoding: 'utf-8',
      confidence: 0.5,
      basis: `${basis}, but decodes to c1 controls (mojibake?)`,
    };
  }

  if (isMostlyControls(text)) {
    return {
      text,
      encoding: 'utf-8',
      confidence: 0.5,
      basis: `${basis}, but the text is mostly control characters (utf-16 without a bom?)`,
    };
  }

  return { text, encoding: 'utf-8', confidence: CERTAIN, basis };
}

/**
 * Longest unbroken stretch of bytes in `0xC0..0xFF`.
 *
 * `0x80..0xBF` is left out of the range on purpose: it is punctuation in *both*
 * code pages — `«` is 0xAB in each, `…` is 0x85 in each — so counting it would
 * let `«…»` pass itself off as a three-byte word.
 */
function longestCyrillicRun(bytes: Uint8Array): number {
  let longest = 0;
  let current = 0;

  for (const byte of bytes) {
    if (byte >= 0xc0) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }

  return longest;
}

/** Which code page an eight-bit body is in, and how strongly it says so. */
function singleByteVerdict(bytes: Uint8Array): {
  encoding: EncodingName;
  confidence: number;
  run: number;
} {
  const run = longestCyrillicRun(bytes);

  if (run >= MIN_CYRILLIC_RUN) {
    // Six bytes is already a whole short word; there is no reading of it that
    // is not Cyrillic. Three is a word too, just a shorter one.
    return { encoding: 'windows-1251', confidence: run >= 6 ? 0.9 : 0.75, run };
  }

  // No high byte at all means the family barely mattered. A scattering of them
  // with nothing adjacent is precisely what Western accented text looks like.
  return { encoding: 'windows-1252', confidence: run === 0 ? 0.85 : 0.7, run };
}

function fromSingleByteVerdict(bytes: Uint8Array, why: string): DecodedText {
  const verdict = singleByteVerdict(bytes);
  return {
    text: decodeAs(verdict.encoding, bytes),
    encoding: verdict.encoding,
    confidence: verdict.confidence,
    basis: `${why}; ${verdict.encoding} at longest cyrillic run ${verdict.run}`,
  };
}

function withoutTrailingNuls(decoded: DecodedText): DecodedText {
  return { ...decoded, text: stripTrailingNulChars(decoded.text) };
}

/**
 * Decode a document whose encoding nothing declares: a cue sheet, an `.nfo`.
 *
 * Order matters. A byte-order mark is a statement of fact and settles the
 * question. Failing that, strict UTF-8 validation is nearly as strong — a run
 * of CP1251 Cyrillic cannot survive it, because those bytes are lead bytes
 * demanding continuations that Cyrillic text never supplies. Only when both
 * fail is there anything to infer, and then it is the run rule above.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (startsWith(bytes, BOM_UTF8)) {
    return {
      text: decodeAs('utf-8', bytes.subarray(3)),
      encoding: 'utf-8',
      confidence: CERTAIN,
      basis: 'utf-8 bom',
    };
  }
  if (startsWith(bytes, BOM_UTF16LE)) {
    return {
      text: decodeAs('utf-16le', bytes.subarray(2)),
      encoding: 'utf-16le',
      confidence: CERTAIN,
      basis: 'utf-16le bom',
    };
  }
  if (startsWith(bytes, BOM_UTF16BE)) {
    return {
      text: decodeAs('utf-16be', bytes.subarray(2)),
      encoding: 'utf-16be',
      confidence: CERTAIN,
      basis: 'utf-16be bom',
    };
  }

  const basis = hasHighByte(bytes) ? 'valid utf-8' : 'ascii; every candidate encoding agrees';
  return fromUtf8(bytes, basis) ?? fromSingleByteVerdict(bytes, 'not valid utf-8');
}

/**
 * Decode one ID3v2 text frame from its declared encoding byte.
 *
 * ID3v2 frames name their own encoding, so usually there is nothing to detect:
 *
 *   0 = ISO-8859-1, 1 = UTF-16 with a BOM, 2 = UTF-16BE, 3 = UTF-8
 *
 * The catch is that the declaration is often a lie. A ripper writes `0` over
 * bytes it actually took from a CP1251 source, or "upgrades" to `3` without
 * converting anything underneath. Taking the byte at its word is how Russian
 * tags become `Àêâàðèóì`. So the declared value is treated as a hint to verify,
 * not as the answer — and when it is contradicted, the basis says so.
 */
export function decodeId3Text(encodingByte: number, bytes: Uint8Array): DecodedText {
  return withoutTrailingNuls(decodeId3Body(encodingByte, bytes));
}

function decodeId3Body(encodingByte: number, body: Uint8Array): DecodedText {
  switch (encodingByte) {
    case 0: {
      const verdict = singleByteVerdict(body);
      if (verdict.encoding === 'windows-1251') {
        return {
          text: decodeAs('windows-1251', body),
          encoding: 'windows-1251',
          confidence: verdict.confidence,
          basis: `id3 declared latin-1, mislabeled windows-1251 at longest cyrillic run ${verdict.run}`,
        };
      }
      const text = decodeAs('windows-1252', body);

      // The declaration is the authority — unless the bytes contradict it. A
      // body that decodes to mostly control characters is not latin-1 text at
      // all: it is what a mangled frame looks like read one byte at a time,
      // and calling that certain is exactly how a row of control characters
      // ends up stored as a title, looking for all the world like one.
      //
      // The same guard `fromUtf8` applies, in the same place in the reasoning.
      // Whether the caller then stores the value is the caller's business;
      // reporting this read as certain is not.
      if (isMostlyControls(text)) {
        return {
          text,
          encoding: 'windows-1252',
          confidence: 0.5,
          basis: 'id3 declared latin-1, but the text is mostly control characters',
        };
      }

      // Declared and actual agree; the declaration is the authority here.
      return {
        text,
        encoding: 'windows-1252',
        confidence: CERTAIN,
        basis: 'id3 declared latin-1',
      };
    }

    case 1: {
      if (startsWith(body, BOM_UTF16LE)) {
        return {
          text: decodeAs('utf-16le', body.subarray(2)),
          encoding: 'utf-16le',
          confidence: CERTAIN,
          basis: 'id3 utf-16, little-endian bom',
        };
      }
      if (startsWith(body, BOM_UTF16BE)) {
        return {
          text: decodeAs('utf-16be', body.subarray(2)),
          encoding: 'utf-16be',
          confidence: CERTAIN,
          basis: 'id3 utf-16, big-endian bom',
        };
      }
      // The spec requires a BOM. Plenty of writers omit it and mean LE.
      return {
        text: decodeAs('utf-16le', body),
        encoding: 'utf-16le',
        confidence: 0.6,
        basis: 'id3 utf-16 without a bom; assumed little-endian',
      };
    }

    case 2:
      return {
        text: decodeAs('utf-16be', body),
        encoding: 'utf-16be',
        confidence: CERTAIN,
        basis: 'id3 utf-16be',
      };

    case 3:
      return (
        fromUtf8(body, 'id3 utf-8') ??
        fromSingleByteVerdict(body, 'id3 declared utf-8, but the bytes are mislabeled')
      );

    default:
      // Not a byte ID3v2 defines. Latin-1 can decode anything without throwing,
      // which is what makes it the safe floor — but it is not a claim.
      return fromSingleByteVerdict(body, `id3 unknown encoding byte ${encodingByte}`);
  }
}

/**
 * Decode a FLAC Vorbis comment.
 *
 * Vorbis comments are UTF-8 by specification, so validation is the entire job:
 * when it holds there was nothing to infer and the answer is certain. It does
 * not always hold — the same rippers that mangle cue sheets wrote these too.
 */
export function decodeVorbisText(bytes: Uint8Array): DecodedText {
  const decoded =
    fromUtf8(bytes, 'vorbis comment is valid utf-8') ??
    fromSingleByteVerdict(bytes, 'vorbis comment is not valid utf-8');

  return withoutTrailingNuls(decoded);
}
