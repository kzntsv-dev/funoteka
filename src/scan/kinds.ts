import { extname } from 'node:path';

/**
 * What a file is, as far as the scanner cares.
 *
 * Only `audio` files are the primary truth of the library; everything else is
 * either a sidecar carrying metadata (cue/nfo/log), artwork, or noise. The
 * spec's split is deliberately coarse — classification of *folders* into
 * album/category/box/disc is a separate concern (see requirements:39 §3).
 */
export type FileKind = 'audio' | 'cue' | 'image' | 'nfo' | 'log' | 'playlist' | 'other';

/** Formats the collection matrix calls out: FLAC / APE / WAV / ALAC(m4a) / MP3 / TTA / AIFF. */
const AUDIO = new Set([
  'flac',
  'ape',
  'wav',
  'm4a', // ALAC and AAC both land here
  'mp3',
  'tta',
  'aiff',
  'aif',
  'aifc',
  'alac',
  // No `mp4`: it is a video container, and audio-only material uses `m4a`
  // above. The collection keeps live clips in `.mp4`, and treating the
  // extension as audio filed a video as a track.
  'ogg',
  'oga',
  'opus',
  'wma',
  'wv',
  'mpc',
  'shn',
  'tak',
  'dsf',
  'dff',
]);

const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff']);

const PLAYLIST = new Set(['m3u', 'm3u8', 'pls']);

export function classifyFile(name: string): FileKind {
  // A leading dot marks a hidden file (`.DS_Store`), not an extension — Node's
  // extname already reports '' for those, which falls through to 'other'.
  const ext = extname(name).toLowerCase().slice(1);
  if (ext === '') return 'other';

  if (AUDIO.has(ext)) return 'audio';
  if (IMAGE.has(ext)) return 'image';
  if (PLAYLIST.has(ext)) return 'playlist';
  if (ext === 'cue') return 'cue';
  if (ext === 'nfo') return 'nfo';
  if (ext === 'log') return 'log';

  return 'other';
}
