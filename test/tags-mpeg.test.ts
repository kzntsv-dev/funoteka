import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readTags } from '../src/tags/read.ts';
import { id3v2, mpeg } from './helpers/bytes.ts';

test('an MPEG stream with no tag block still states its length', () => {
  // The commonest thing in the collection: a bare mp3 with no ID3 at all. It
  // has no tag, and it still knows exactly how long it plays.
  const bytes = mpeg({ frames: 100, sampleRate: 48000, bitrateKbps: 128 });

  assert.equal(readTags(bytes).durationMs, 2_400);
});

test('a Xing header is trusted over counting, and gives the same answer', () => {
  const bytes = mpeg({ frames: 100, sampleRate: 48000, bitrateKbps: 128, header: 'Info' });
  const scanned = mpeg({ frames: 100, sampleRate: 48000, bitrateKbps: 128 });

  assert.equal(readTags(bytes).durationMs, 2_400);
  assert.equal(readTags(scanned).durationMs, 2_400, 'the header and the scan must agree');
});

test('a variable bitrate is counted, not averaged from the first frame', () => {
  // 50 frames at 128 kbps then 50 at 320. Estimating from the first frame's
  // bitrate would report far longer than the file plays; walking the frames
  // gives the truth without needing to know which kind of stream this is.
  const vbr = [...Array(50).fill(128), ...Array(50).fill(320)];
  const bytes = mpeg({ frames: 100, sampleRate: 48000, vbr });

  assert.equal(readTags(bytes).durationMs, 2_400, 'samples per frame do not depend on bitrate');
});

test('MPEG-2 counts 576 samples a frame, not 1152', () => {
  // Halving this is the classic way to report a low-bitrate rip at double
  // length, and nothing about the file would look wrong.
  const bytes = mpeg({ version: 2, frames: 100, sampleRate: 24000, bitrateKbps: 64 });

  assert.equal(readTags(bytes).durationMs, 2_400);
});

test('a tag in front does not hide the audio behind it', () => {
  // Where the file actually lives: an ID3v2 block, then the frames. The tags
  // come from the tag and the duration from the audio, out of one read.
  const tag = id3v2([{ id: 'TIT2', encoding: 3, text: Buffer.from('A Song', 'utf8') }]);
  const bytes = Buffer.concat([tag, mpeg({ frames: 100, sampleRate: 48000, bitrateKbps: 128 })]);
  const result = readTags(bytes);

  assert.equal(result.durationMs, 2_400);
  assert.deepEqual(result.tags, [{ name: 'title', value: 'A Song' }]);
});

test('an mp3 is a format the reader understands, even with nothing in it', () => {
  // It must not be reported as a format nothing recognises — that would be a
  // lie about a third of the collection's most ordinary files.
  assert.equal(readTags(mpeg({ frames: 10 })).container, 'mpeg');
  assert.notEqual(
    readTags(Buffer.concat([id3v2([]), mpeg({ frames: 10 })])).container,
    null,
  );
});

test('bytes with no frame at all say nothing rather than the wrong thing', () => {
  assert.equal(readTags(Buffer.from('not mpeg, just words', 'utf8')).durationMs, null);
  // A sync byte followed by nonsense is not the start of a stream.
  assert.equal(readTags(Buffer.from([0xff, 0xfb, 0x00, 0x00, 0x00, 0x00])).durationMs, null);
});

test('a stream cut off mid-frame still states what it holds', () => {
  const whole = mpeg({ frames: 20, sampleRate: 48000, bitrateKbps: 128 });
  const cut = whole.subarray(0, Math.floor(whole.length / 2));

  const duration = readTags(cut).durationMs;
  assert.ok(duration !== null && duration > 0 && duration < 480, `unexpected ${duration}`);
  // A file that ran out of bytes was not lost — it plays exactly as far as it
  // goes, and saying so is the honest answer. Only a walk that gave up with the
  // stream still ahead of it has something to hide.
  assert.equal(readTags(cut).durationRefused, false);
});

test('a walk that loses the stream says so instead of reporting short', () => {
  // The failure this exists for: `02. 218 Tracks.mp3` walked 412 KB of 3.98 MB
  // and returned 17 seconds against a true 165. Nothing about that number looks
  // wrong, which is why it has to be withheld rather than stored — there is
  // another reader to ask, and it answers correctly.
  const bytes = Buffer.concat([
    mpeg({ frames: 200, sampleRate: 48000, bitrateKbps: 128 }),
    Buffer.alloc(100_000),
  ]);

  const read = readTags(bytes);
  assert.equal(read.durationMs, null, 'a number known to be short is worse than none');
  assert.equal(read.durationRefused, true);
  // Still a format this project understands; the length is what is missing.
  assert.equal(read.container, 'mpeg');
});

test('a couple of frames inside something else is not a stream', () => {
  // What an `.m4a` looks like to this reader: two headers line up by chance and
  // then nothing does. Measured across 229 real m4a files, every such
  // coincidence stopped at exactly two — while the one genuine damaged stream
  // in the same collection ran to 657. Claiming these bytes as mpeg is worse
  // than declining to: the container named would be a lie, and an m4a would
  // stop being counted among the formats nothing here reads.
  const bytes = Buffer.concat([
    Buffer.alloc(50_000),
    mpeg({ frames: 2, sampleRate: 44100, bitrateKbps: 128 }),
    Buffer.alloc(50_000),
  ]);

  const read = readTags(bytes);
  assert.equal(read.container, null, 'no container was found, because none is there');
  assert.equal(read.durationMs, null);
  assert.equal(read.durationRefused, false, 'nothing to hand to ffprobe');
});

test('a trailing ID3v1 tag is not a lost stream', () => {
  // 128 bytes of tag after the audio is ordinary, and reading it as a failed
  // walk would send a whole collection to ffprobe for nothing.
  const audio = mpeg({ frames: 100, sampleRate: 48000, bitrateKbps: 128 });
  const v1 = Buffer.alloc(128);
  v1.write('TAG', 0, 'latin1');

  const read = readTags(Buffer.concat([audio, v1]));
  assert.equal(read.durationMs, 2_400);
  assert.equal(read.durationRefused, false);
});

test('a stream that simply ends is not refused', () => {
  assert.equal(
    readTags(mpeg({ frames: 100, sampleRate: 48000, bitrateKbps: 128 })).durationRefused,
    false,
  );
});

test('a VBRI header is read, and read where Fraunhofer writes it', () => {
  // The one branch in this reader no file has ever run: VBRI is Fraunhofer's
  // header, no specification in hand describes it, and not one of the 700 mp3
  // files in the collection carries one. So the layout was settled by
  // construction rather than by recollection — these same bytes were handed to
  // ffmpeg, which named 522 ms for a twenty-frame stream and 26 ms when the
  // count was moved ten bytes earlier, exactly as this reader does. Two
  // implementations written independently, agreeing on the right answer and on
  // the same wrong one.
  const bytes = mpeg({ frames: 20, header: 'VBRI' });

  assert.equal(readTags(bytes).durationMs, 522);
});

test('the count a header states is the one that is used, not the one walked', () => {
  // With the header and the stream agreeing, a reader that ignores the header
  // passes the test above by walking to the same number. Thirty stated over
  // twenty written tells the two apart: the header is a statement, and a
  // statement that is not read is not a decision.
  const bytes = mpeg({ frames: 20, header: 'VBRI', headerFrames: 30 });

  assert.equal(readTags(bytes).durationMs, 784);
});

// The layers below are the ones the collection does not hold. Every mp3 in it is
// Layer III, so nothing here had ever executed the reader's Layer I or Layer II
// path — the tables, the samples-per-frame column or the frame-length formula —
// and the fixture could not write one to check them with. These are that
// (task:2756, finding 11). What a fixture cannot settle is whether its own
// tables are right, and that is `test/tools/mpeg-layers-vs-ffprobe.ts`.

test('Layer I carries 384 samples, and counts its frame in four-byte slots', () => {
  // A Layer I frame is `(floor(12·bitrate/rate) + padding) · 4` where Layers II
  // and III are a byte count. Read with their formula the first frame comes out
  // 731 bytes where the stream lays it down at 240, so the walk finds no second
  // frame at that offset and the file reports no length at all — which is why a
  // wrong formula here shows up as silence rather than as a wrong number.
  const bytes = mpeg({ layer: 'I', frames: 100, sampleRate: 44100, bitrateKbps: 224 });

  assert.equal(readTags(bytes).durationMs, 871);
  assert.equal(readTags(bytes).codec, 'mp1', 'and the walk names what it walked');
});

test("a Layer I frame's padding is a whole four-byte slot", () => {
  // The same term as Layer III's, in a different unit: one slot of four bytes
  // rather than one byte, so a reader that added one byte would be three short
  // on every frame.
  //
  // 96 kbps is not an arbitrary choice. At 224 the two formulas happen to agree
  // on a padded frame — 244 both ways, one of them by arithmetic accident — and
  // the test passed against a reader that had the Layer I formula removed
  // entirely. Here they are 108 and 105, and the walk notices.
  const bytes = mpeg({
    layer: 'I',
    frames: 100,
    sampleRate: 44100,
    bitrateKbps: 96,
    padding: true,
  });

  assert.equal(readTags(bytes).durationMs, 871);
  assert.equal(readTags(bytes).durationRefused, false, 'the walk followed it to the end');
});

test('padding is one byte at Layer III, where a CBR stream uses it nine frames in ten', () => {
  // Off, every frame is the floor of the formula and the bit could be ignored
  // without a test noticing; on, the walk has to read it or lose the stream.
  const padded = mpeg({
    layer: 'III',
    frames: 100,
    sampleRate: 44100,
    bitrateKbps: 128,
    padding: true,
  });
  const plain = mpeg({ layer: 'III', frames: 100, sampleRate: 44100, bitrateKbps: 128 });

  assert.equal(readTags(padded).durationMs, 2_612);
  assert.equal(readTags(plain).durationMs, 2_612, 'and padding changes no sample count');
});

test('Layer II has a bitrate table of its own, and MPEG-1 Layer II reaches 384', () => {
  // 384 is in the Layer II column and not in Layer III's, which stops at 320. A
  // reader that read one layer's table at the other's index finds a real bitrate
  // at a real index and lays the frames out to a different length than the
  // stream did — silent, and the number that comes back is a duration, just not
  // this file's.
  const bytes = mpeg({ layer: 'II', frames: 100, sampleRate: 44100, bitrateKbps: 384 });

  assert.equal(readTags(bytes).durationMs, 2_612);
  assert.equal(readTags(bytes).codec, 'mp2');
});

test('Layer II carries 1152 samples at MPEG-2, where Layer III carries 576', () => {
  // The column that differs by layer rather than by version: only Layer III
  // halves at MPEG-2, and reading the halved figure for Layer II reports a
  // low-bitrate mp2 at half its length.
  const bytes = mpeg({
    version: 2,
    layer: 'II',
    frames: 100,
    sampleRate: 22050,
    bitrateKbps: 160,
  });

  assert.equal(readTags(bytes).durationMs, 5_224);
});

test('Layer I at MPEG-2.5 reads the lower table and still 384 samples a frame', () => {
  const bytes = mpeg({
    version: 25,
    layer: 'I',
    frames: 100,
    sampleRate: 8000,
    bitrateKbps: 256,
  });

  assert.equal(readTags(bytes).durationMs, 4_800);
});

test('an mp3 states its own sample rate and channel count', () => {
  // Both live in the frame header this reader already parses, and the walk that
  // measures the length has one of those frames in hand. Leaving them null cost
  // the collection twice over (task:2910): the decision path spawned ffprobe to
  // learn what the bytes had already said, and every mp3 whose channel count
  // nothing had filled was re-encoded whole — 2.4 seconds cold for a file that
  // needed no work at all, because `alreadyIs` could not answer the cap.
  const stereo = readTags(mpeg({ frames: 100, sampleRate: 48000, bitrateKbps: 128 }));
  assert.equal(stereo.sampleRate, 48_000);
  assert.equal(stereo.channels, 2);

  const mono = readTags(
    mpeg({ frames: 100, sampleRate: 44_100, bitrateKbps: 128, channels: 1 }),
  );
  assert.equal(mono.sampleRate, 44_100);
  assert.equal(mono.channels, 1);
});

test('a tag block in front does not hide the channel count behind it', () => {
  // Where the collection's files actually live: ID3v2 first, frames after. The
  // names come from the tag and the format from the audio, out of one read —
  // the tag block never knew either number.
  const tag = id3v2([{ id: 'TIT2', encoding: 3, text: Buffer.from('A Song', 'utf8') }]);
  const bytes = Buffer.concat([
    tag,
    mpeg({ frames: 100, sampleRate: 48_000, bitrateKbps: 128, channels: 1 }),
  ]);
  const result = readTags(bytes);

  assert.equal(result.sampleRate, 48_000);
  assert.equal(result.channels, 1);
});

test('a refused length still names the format, and is not read as a short one', () => {
  // The refusal path hands the length to ffprobe. The format is a separate
  // question and the walk answered it either way — dropping it here would put
  // the decision path back to spawning a process for a file whose codec, rate
  // and channel count are all in the bytes that were just read.
  const bytes = mpeg({ frames: 100, sampleRate: 48_000, bitrateKbps: 128 });
  const withGap = Buffer.concat([bytes, Buffer.alloc(20_000)]);

  const result = readTags(withGap);
  assert.equal(result.durationRefused, true, 'a lost tail is refused, not counted');
  assert.equal(result.codec, 'mp3');
  assert.equal(result.sampleRate, 48_000);
  assert.equal(result.channels, 2);
});
