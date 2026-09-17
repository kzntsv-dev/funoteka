import { statSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

import { id3v2, type TrackTags } from '../tags/encode.ts';
import { firstFrame, isEncoderFrame, readFrame } from '../tags/mpeg.ts';
import type { ByteSegment } from './segment.ts';

/**
 * A slice of an mp3 image, as an mp3 stream.
 *
 * mp3 is the easy one, and it is worth saying why, because it looks like the
 * hard one. Its frames *are* self-delimiting: a frame's header states a bitrate
 * and a sample rate, and those give the frame's length in bytes without any
 * decoding at all. So a walk can simply step from frame to frame, and both ends
 * of a segment are found exactly, with no search and no guessing. And nothing in
 * an mp3 states the stream's total length — a player counts frames — so a slice
 * of the stream needs no header rebuilt in front of it, only the frames.
 *
 * What *does* have to be built is the tag block, and this is the other half of
 * task:2895. An image's tags sit in front of its first frame, and a segment cut
 * out of the middle begins at a frame — so the cut left every tag behind and a
 * client that saved it had a file nothing could name. The tags written here are
 * the song's own, from the meta layer, for the reason `tags/encode.ts` states:
 * the image's describe the disc, and a track wearing them is worse off than one
 * wearing nothing.
 *
 * The one thing that has to go is the encoder's own header frame. LAME writes
 * `Xing`/`Info` into the side info of the first frame and Fraunhofer `VBRI`, and
 * that frame carries no audio; it states the frame count of the *whole* file,
 * which served at the head of a five-minute segment would tell a client it is
 * holding an hour. Leaving it out is also what keeps the served bytes in step
 * with the times they were chosen by, since the walk does not count it either.
 *
 * The frame reader itself is `tags/mpeg.ts`, which is checked field by field
 * against MP3'Tech and holds its three unsourced tables up by measurement
 * against ffprobe's own frame count. Nothing here re-derives any of that.
 */

/**
 * What a frame header occupies: the sync word, and the three bytes that state
 * the version, the layer, the bitrate and the sample rate.
 *
 * That is all the walk needs, because the frame's length comes out of those
 * four bytes and nothing else is read. It used to ask for forty-four — enough
 * for the side info and the encoder magic a *different* reader looks for — and
 * a window that insists on forty-four bytes cannot answer for a frame that
 * starts closer than that to the end of the file. A low bitrate makes exactly
 * that shape: MPEG-2 at 8 kbps is 26 bytes a frame, so the last one of a file
 * sat inside the room the window was holding back (task:2846).
 */
const HEADER = 4;

/**
 * A window onto one file, refilled as the walk moves along it.
 *
 * The walk never needs more than a frame's header at a time — the next frame's
 * position comes out of this one's — so an mp3 of any size is read a few bytes
 * at a time, and nothing is held afterwards.
 */
class Window {
  private buffer: Buffer = Buffer.alloc(0);
  private base = 0;
  private readonly file: FileHandle;
  private readonly size: number;

  constructor(file: FileHandle, size: number) {
    this.file = file;
    this.size = size;
  }

  /**
   * The `need` bytes at `at`, or null when the file does not hold that many.
   *
   * Awaited, so that the walk of an image yields between windows instead of
   * holding the event loop for the whole file — see `buildIndex` in `flac.ts`,
   * where the same walk cost this single-threaded server 385 ms of answering
   * nobody (measured, task:2897).
   */
  async at(at: number, need: number): Promise<Buffer | null> {
    if (at + need > this.size) return null;
    if (at < this.base || at + need > this.base + this.buffer.length) {
      const span = Math.min(1 << 16, this.size - at);
      const buffer = Buffer.allocUnsafe(span);
      const read = await this.file.read(buffer, 0, span, at);
      if (read.bytesRead < need) return null;
      this.buffer = buffer.subarray(0, read.bytesRead);
      this.base = at;
    }
    return this.buffer.subarray(at - this.base, at - this.base + need);
  }
}

/**
 * The frames of one segment, and where they are.
 *
 * Null when the segment cannot be walked to its end — a stream that breaks
 * before the end of the track is a file this cannot answer for, and a caller
 * that got a range anyway would be serving silence or somebody else's audio
 * under this track's name.
 *
 * Walking *to the end* is not the same as covering the request to the sample.
 * The end comes from a duration the scan rounded to the millisecond, so it can
 * ask for a fraction of a frame the file does not hold; the frames running out
 * there is the end of the audio. The line between that and a broken stream is a
 * frame, and it is drawn at the walk — see the note there.
 */
export async function mpegSegment(
  path: string,
  startMs: number,
  endMs: number,
  tags: TrackTags,
): Promise<ByteSegment | null> {
  const size = statSync(path).size;
  const file = await open(path, 'r');

  try {
    // The first frame of the stream, found by resynchronising past whatever
    // tags stand in front of it. `firstFrame` wants the bytes in hand, and the
    // tag it may be standing behind is the reason this reads a megabyte rather
    // than a header's worth.
    const head = Buffer.alloc(Math.min(size, 1 << 20));
    await file.read(head, 0, head.length, 0);

    const first = firstFrame(head, 0);
    if (first === null) return null;

    // Past the encoder's frame, if the stream opens with one.
    let at = isEncoderFrame(head, first) ? first.at + first.size : first.at;

    const window = new Window(file, size);
    const rate = first.sampleRate;
    const startSample = Math.floor((startMs * rate) / 1000);
    const endSample = Math.floor((endMs * rate) / 1000);

    let from: number | null = null;
    let consumed = 0;
    /**
     * What the frame before carried, which is the yardstick below for "the
     * frames have run out" — nothing of the file, only of the last frame read.
     */
    let lastFrame = 0;

    for (;;) {
      if (consumed >= endSample) break;

      const bytes = await window.at(at, HEADER);
      const frame = bytes === null ? null : readFrame(bytes, 0);

      if (frame === null) {
        // The frames have run out. That is the end of the audio, and it is not
        // the same thing as a stream that broke: the request's end comes from a
        // duration the scan rounded to the millisecond, so it can ask for a
        // fraction of a frame more than the file holds — eight and eighteen
        // samples of a 1152-sample frame, over three tracks of the live
        // collection that were refused whole for it (task:2846). Nothing is
        // missing there by a frame, and what is left after the last frame is a
        // tag, not audio.
        //
        // One frame is where the line is drawn, and it is wide: the rounding of
        // a millisecond is at most a fiftieth of a frame at any rate and bitrate
        // this format has. A file that really is missing audio is missing a
        // whole frame or more of it, and that is still refused.
        if (endSample - consumed <= lastFrame) break;
        return null;
      }

      // The frame a moment falls inside, not the one after it: a client that
      // seeks to 1:30 wants the music that is playing at 1:30, and the frame
      // holding it is the one that starts at or before it.
      if (from === null && consumed + frame.samplesPerFrame > startSample) from = at;

      consumed += frame.samplesPerFrame;
      lastFrame = frame.samplesPerFrame;
      at += frame.size;
    }

    if (from === null) return null;

    // No header to restate: mp3 states no length anywhere a player reads and
    // numbers its frames from nowhere, so the frames go out as the file holds
    // them. What is put in front of them is the song's tags and nothing else —
    // the frame *reader* has already stepped past the file's own tag block, so
    // this cannot double up with one.
    //
    // The end is held to the file. A frame's length comes from its header, so a
    // file cut off inside its last frame walks to the end of that frame — a byte
    // offset past the end of the file — and a segment that ended there would
    // promise more bytes than the file holds: `content-length` one number, the
    // stream a shorter body, and a client reading that as a download that
    // stopped. The frames ran out at the end of the file, and that is where the
    // audio ends (task:2848).
    return { prefix: id3v2(tags), from, to: Math.min(at, size), frames: [] };
  } finally {
    await file.close();
  }
}
