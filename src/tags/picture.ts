/**
 * The picture block, as RFC 9639 section 8.8 defines it.
 *
 * Extracted from `flac.ts` and shared, because the same block turns up in two
 * places that have nothing else to do with each other. A FLAC file carries it as
 * metadata block type 6; a Vorbis comment carries it base64-encoded under the
 * name `METADATA_BLOCK_PICTURE`, which is how an Ogg file holds a cover at all —
 * Ogg has no metadata block of its own to put one in. The bytes of the block are
 * identical in both, down to the four 32-bit dimensions in the middle, and one
 * parser for them is one place for the layout to be wrong.
 *
 * In order: a 32-bit picture type, a 32-bit length and the MIME string, another
 * length and the description, then four 32-bit numbers (width, height, colour
 * depth, number of colours), then the length of the image and the image. The
 * four dimensions are stepped over rather than read — a cover's size is the
 * client's business, and none of them is a number this project wants.
 *
 * Everything here is null when the block is not laid out the way the section
 * says. A description in the middle is what makes that likely enough to check:
 * it is arbitrary text of arbitrary length, and a reader that trusted the two
 * lengths it read first would point at the middle of a caption and serve it as
 * a picture.
 */

function readUInt32BE(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

/** Where a picture's bytes are, and what they are. */
export interface PictureBlock {
  mime: string;
  kind: number;
  /** Absolute offset of the image within the array the block was read from. */
  dataAt: number;
  dataLength: number;
}

/**
 * Read the picture block occupying `[at, end)`, or null when there is not one.
 *
 * `dataAt` is an offset into the array this was handed, whatever that array is —
 * the file, for a FLAC metadata block, or a decoded comment value, for one that
 * came base64-encoded out of a Vorbis comment. The caller is the only one that
 * knows which, and the two mean different things by it, so it is stated rather
 * than assumed: see `TagPicture.pages` on why an Ogg picture is not a range of
 * its file at all.
 */
export function pictureBlockAt(bytes: Uint8Array, at: number, end: number): PictureBlock | null {
  if (end > bytes.length) return null;

  const take = (cursor: number): { value: number; next: number } | null => {
    if (cursor + 4 > end) return null;
    return { value: readUInt32BE(bytes, cursor), next: cursor + 4 };
  };

  const type = take(at);
  if (type === null) return null;

  const mimeLength = take(type.next);
  if (mimeLength === null) return null;
  const mimeStart = mimeLength.next;
  if (mimeStart + mimeLength.value > end) return null;
  const mime = Buffer.from(bytes.subarray(mimeStart, mimeStart + mimeLength.value)).toString('latin1');

  const descriptionLength = take(mimeStart + mimeLength.value);
  if (descriptionLength === null) return null;

  // The description, then the four dimensions, then the length of the image.
  const imageLengthAt = descriptionLength.next + descriptionLength.value + 16;
  const imageLength = take(imageLengthAt);
  if (imageLength === null) return null;

  const dataAt = imageLength.next;
  if (imageLength.value <= 0 || dataAt + imageLength.value > end) return null;

  return { mime, kind: type.value, dataAt, dataLength: imageLength.value };
}
