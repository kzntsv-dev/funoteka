import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  codecOf,
  containerOf,
  cutByHand,
  formatFor,
  isLossless,
  playable,
  streamOf,
  type TranscodeTarget,
} from '../stream/segment.ts';

import { parseId, required } from './browse.ts';
import { ApiError, ERROR } from './envelope.ts';
import { song, type SongRow } from './meta.ts';
import type { Payload, RouteContext } from './router.ts';
import { serveSong } from './stream.ts';

/**
 * The `transcoding` extension: a client asks what to do with a song, and then
 * asks for it.
 *
 * The protocol's older way of transcoding is a query string — `format=mp3` and
 * `maxBitRate=128` — and it works because a client that knows what it can play
 * can name it in two parameters. The extension replaces that with a
 * conversation, and the reason is that a real client's capabilities are not two
 * parameters: Symfonium, Sonos and every other player that has an opinion about
 * containers carries a *list* of profiles, each with codecs, channel counts and
 * codec-specific limits on sample rate and bit depth.
 *
 * So `getTranscodeDecision` is a POST, because that list does not fit in a URL
 * — the specification says so in as many words — and the server answers with
 * what it would do: play it as it is, or convert it, and if convert, what into.
 * `getTranscodeStream` then answers with the stream, and it is handed the
 * decision back as an opaque `transcodeParams` so that the two calls cannot
 * disagree about what was decided.
 *
 * **What is here is only what this server can actually do**, and that is the
 * whole of the volume decision: `hls` is skipped, because this server produces
 * no HLS and `requirements:47` puts the method in the stubs. A client whose
 * profiles are all HLS is told `canTranscode: false`, which is true, rather than
 * promised a stream that would arrive as an error.
 *
 * **One place where the specification leaves the consequence to the server**,
 * and it is decided here: `required: false` on a limitation means a breach does
 * not block. The specification defines the field — "Whether this limitation must
 * be met" — and marks it required, and never says what a breach of a non-required
 * one costs. The reading taken here is the one with the cheaper failure mode:
 * the alternative transcodes for a limitation the client itself said need not
 * hold, on a phone, for every song. A profile that omits the field entirely gets
 * the same treatment, which is the tolerance the rest of this module shows a
 * client that spells something wrongly — it is answered as though it had said
 * nothing.
 *
 * (`protocols: []` stood here as a second such place until the contract axis
 * read the schema: `openapi/schemas/DirectPlayProfile.json` says "An empty array
 * means any protocols", in the same breath as the containers and the codecs. The
 * code was right and the claim about its source was not, which is the class of
 * thing this project weighs as much as a bug.)
 */

/** The protocol's one transport, and the only one this server produces. */
const HTTP = 'http';

/** The version of the decision this server issues, and of the token it signs. */
const TOKEN_VERSION = 1;

/**
 * A ceiling no stream this server makes could reach, and so no ceiling at all.
 *
 * It is here to keep the token's space finite: the value a client sends back is
 * checked against it, and a number the decision would never have issued is a
 * refusal rather than an ffmpeg argument. Ten megabits per second is four times
 * the largest thing a CD-resolution stream can be.
 */
const MAX_CEILING_KBPS = 10_000;

/**
 * The widest channel count a decision will ever put in a token.
 *
 * A cap at or above this cannot limit any recording, so it is not treated as a
 * cap at all — the same reasoning as `MAX_CEILING_KBPS` above, and it is what
 * keeps the two ends of the token honest: `readToken` refuses a channel count
 * this high, so a decision that passed one on unclamped would hand a client a
 * token its own server then rejected, with "ask getTranscodeDecision for one"
 * as the advice — a loop. That was a real defect, found by the standards axis
 * and not by this suite: a client naming 33 channels was issued the token
 * `readToken` refuses (task:2896).
 */
const MAX_CHANNELS = 32;

// --- what the client says about itself --------------------------------------

/**
 * One profile of a client's `ClientInfo`, as this server reads it.
 *
 * Deliberately looser than the specification: every field is optional here and
 * an absent one means what the protocol says an absent one means. A client that
 * spells a field wrongly is not refused over it — it is answered as though it
 * had said nothing, which is the failure mode that leaves a client working.
 */
interface DirectPlayProfile {
  containers: string[];
  audioCodecs: string[];
  protocols: string[];
  maxAudioChannels: number | null;
}

interface TranscodingProfile {
  container: string;
  audioCodec: string;
  protocol: string;
  maxAudioChannels: number | null;
}

interface Limitation {
  name: string;
  comparison: string;
  values: string[];
  required: boolean;
}

interface CodecProfile {
  name: string;
  limitations: Limitation[];
}

interface ClientInfo {
  maxAudioBitrate: number | null;
  maxTranscodingAudioBitrate: number | null;
  directPlayProfiles: DirectPlayProfile[];
  transcodingProfiles: TranscodingProfile[];
  codecProfiles: CodecProfile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * The numbers a limitation compares against, as the strings the spec types them
 * as.
 *
 * The specification writes the field's type as `string` and its own examples
 * send arrays of strings — and one of them sends integers. Both reach here, so
 * both are read, and anything else is dropped rather than coerced.
 */
function valuesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === 'string'
        ? item
        : typeof item === 'number' && Number.isFinite(item)
          ? String(item)
          : null,
    )
    .filter((item): item is string => item !== null);
}

function intOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The client's capabilities, off the request body.
 *
 * A body that is not there, or is not JSON, is refused with a sentence rather
 * than answered with a decision made up from nothing: an empty `ClientInfo`
 * means "this client has told me nothing", and the honest answer to that is not
 * `canDirectPlay: false` — it is that the question was not asked.
 */
function clientInfoOf(body: string | null): ClientInfo {
  if (body === null || body.trim() === '') {
    throw new ApiError(
      ERROR.missingParameter,
      'getTranscodeDecision needs the client capabilities in the request body: the specification puts them there because they do not fit in a query string',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new ApiError(
      ERROR.generic,
      `The request body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ApiError(ERROR.generic, 'The request body is not a JSON object of client capabilities');
  }

  return {
    maxAudioBitrate: intOf(parsed['maxAudioBitrate']),
    maxTranscodingAudioBitrate: intOf(parsed['maxTranscodingAudioBitrate']),
    directPlayProfiles: recordsOf(parsed['directPlayProfiles']).map((profile) => ({
      containers: stringsOf(profile['containers']),
      audioCodecs: stringsOf(profile['audioCodecs']),
      protocols: stringsOf(profile['protocols']),
      maxAudioChannels: intOf(profile['maxAudioChannels']),
    })),
    transcodingProfiles: recordsOf(parsed['transcodingProfiles']).map((profile) => ({
      container: textOf(profile['container']),
      audioCodec: textOf(profile['audioCodec']),
      protocol: textOf(profile['protocol']),
      maxAudioChannels: intOf(profile['maxAudioChannels']),
    })),
    codecProfiles: recordsOf(parsed['codecProfiles']).map((profile) => ({
      name: textOf(profile['name']),
      limitations: recordsOf(profile['limitations']).map((limitation) => ({
        name: textOf(limitation['name']),
        comparison: textOf(limitation['comparison']),
        values: valuesOf(limitation['values']),
        required: limitation['required'] === true,
      })),
    })),
  };
}

// --- what the server knows about the file -----------------------------------

/**
 * The source stream, as this server can describe it.
 *
 * **Not everything the specification's `StreamDetails` can hold is here**, and
 * the absence is a fact about this collection rather than a shortcut. Measured
 * on the live library: of 3173 probed files, `bitrate` is null for 3005 and
 * `sample_rate` and `channels` for 2153 — every one of the 1425 `.m4a` and 728
 * `.mp3` among them. Those fields are `Req. No` in the spec, so what is not
 * known is left out rather than guessed at, and `bitDepth` is never known at all
 * because nothing in this server reads it.
 */
interface Source {
  /** The container in the protocol's vocabulary — `mp4`, not `m4a`. */
  container: string;
  codec: string;
  channels: number | null;
  samplerate: number | null;
  bitrate: number | null;
}

/**
 * What the file's audio is at, in bits per second.
 *
 * The meta layer's own reading where the probe took one — and it took one for a
 * sixth of this collection, so where there is none it is worked out from the two
 * things the scan always has: the file's size and its measured length. That is
 * an average over the whole file and is only ever read as one; it is still the
 * number that answers the client's question, which is whether this file is more
 * than the link it is being asked for across.
 *
 * **Only for a whole file.** A cue track's row carries the *image's* size beside
 * its own duration, so dividing one by the other would give a disc's bytes
 * divided by a track's length — inflated by the number of tracks on the record,
 * and worse than no number at all.
 */
function bitrateOf(row: SongRow): number | null {
  if (row.bitrate !== null) return row.bitrate;
  if (row.segment_start_ms !== null) return null;
  if (row.duration_ms === null || row.duration_ms <= 0) return null;
  return Math.round((row.size * 8 * 1000) / row.duration_ms);
}

/**
 * Whether the server would send this media's own bytes, untranscoded.
 *
 * The same question `stream` answers before it reaches for ffmpeg, asked with
 * the same two predicates — `playable` for a whole file and `cutByHand` for a
 * stretch of an image — so that the decision and the delivery cannot disagree.
 *
 * **This is the half of `canDirectPlay` that is about the server.** The other
 * half is the client's own profiles, and both are needed: a client that plays
 * ALAC would be told it can play this file directly, and then handed FLAC by a
 * server whose own default is to re-encode what a browser cannot read. A
 * `canDirectPlay` a client acts on by calling `stream` has to mean what `stream`
 * will do, and not merely what the client is capable of.
 */
function handsOver(row: SongRow, codec: string): boolean {
  return row.segment_start_ms === null ? playable(codec, row.ext) : cutByHand(row.ext);
}

/** Why the server would not, in the words of the one method that decides it. */
function whyServerReencodes(row: SongRow, codec: string): string {
  return row.segment_start_ms === null
    ? `ServerReencodesUnplayable: ${codec} in ${containerOf(row.ext)}`
    : `ServerReencodesSegmentOf: ${containerOf(row.ext)}`;
}

// --- the decision -----------------------------------------------------------

interface StreamDetails {
  protocol: string;
  container: string;
  codec: string;
  audioChannels?: number;
  audioBitrate?: number;
  audioProfile?: string;
  audioSamplerate?: number;
  audioBitdepth?: number;
}

interface Decision {
  canDirectPlay: boolean;
  canTranscode: boolean;
  transcodeReason?: string[];
  errorReason?: string;
  transcodeParams?: string;
  sourceStream: StreamDetails;
  transcodeStream?: StreamDetails;
}

function detailsOf(source: Source): StreamDetails {
  return {
    protocol: HTTP,
    container: source.container,
    codec: source.codec,
    ...(source.channels === null ? {} : { audioChannels: source.channels }),
    ...(source.bitrate === null ? {} : { audioBitrate: source.bitrate }),
    ...(source.samplerate === null ? {} : { audioSamplerate: source.samplerate }),
  };
}

/**
 * The value of the parameter a limitation names, or nothing.
 *
 * Nothing means "this server cannot tell you", and it is returned for two
 * different reasons that are deliberately not distinguished: the file's own
 * reading is missing (see `Source`), and the limitation names something no
 * reading would give — `audioProfile` is a string and this server stores none,
 * and `audioBitdepth` is read by nothing here.
 *
 * A limitation that cannot be evaluated is **not** a breach. The alternative is
 * to call every file with an unmeasured sample rate unfit for direct play, which
 * on this collection is two files in three — and would answer "you must
 * transcode" about music that needs no transcoding, to a phone on a battery. The
 * cost of being wrong the other way is one failed attempt at a play, after which
 * a client asks again; the cost of this way is a transcode of everything.
 */
function parameterOf(name: string, source: Source): number | null {
  switch (name) {
    case 'audioChannels':
      return source.channels;
    case 'audioBitrate':
      return source.bitrate;
    case 'audioSamplerate':
      return source.samplerate;
    default:
      return null;
  }
}

/** Whether a limitation holds of the file, or nothing where it cannot be told. */
function holds(limitation: Limitation, source: Source): boolean | null {
  const value = parameterOf(limitation.name, source);
  const first = limitation.values[0];
  if (value === null || first === undefined) return null;

  switch (limitation.comparison) {
    case 'Equals':
      return limitation.values.includes(String(value));
    case 'NotEquals':
      return !limitation.values.includes(String(value));
    case 'LessThanEqual': {
      const bound = Number(first);
      return Number.isNaN(bound) ? null : value <= bound;
    }
    case 'GreaterThanEqual': {
      const bound = Number(first);
      return Number.isNaN(bound) ? null : value >= bound;
    }
    // A comparison this server does not know is not a breach for the same reason
    // an unreadable parameter is not one: it cannot be shown to fail.
    default:
      return null;
  }
}

/**
 * Why this client's direct-play profile does not take the file — or nothing,
 * which is the answer when it does.
 *
 * **One string per profile, which is what the specification asks for**: its
 * `transcodeReason` is "server specific made for logging purpose" and the server
 * "should return 1 string per direct play profile". The strings are therefore
 * about *profiles* and not about the file, and the same file can be refused for
 * three different reasons by three profiles.
 */
function refusesProfile(
  profile: DirectPlayProfile,
  client: ClientInfo,
  source: Source,
): string | null {
  // An empty list is no restriction, and here the specification says so itself:
  // "The list of supported protocols. An empty array means any protocols"
  // (`openapi/schemas/DirectPlayProfile.json`), which is what it says of the
  // containers and the codecs beside it.
  if (profile.protocols.length > 0 && !profile.protocols.includes(HTTP)) {
    return `ProtocolNotSupported: ${profile.protocols.join(', ')}`;
  }
  if (
    profile.containers.length > 0 &&
    !profile.containers.some((name) => containerOf(name) === source.container)
  ) {
    return `ContainerNotSupported: ${source.container}`;
  }
  if (profile.audioCodecs.length > 0 && !profile.audioCodecs.includes(source.codec)) {
    return `AudioCodecNotSupported: ${source.codec}`;
  }
  if (
    profile.maxAudioChannels !== null &&
    source.channels !== null &&
    source.channels > profile.maxAudioChannels
  ) {
    return `AudioChannelsNotSupported: ${source.channels}`;
  }
  if (
    client.maxAudioBitrate !== null &&
    client.maxAudioBitrate > 0 &&
    source.bitrate !== null &&
    source.bitrate > client.maxAudioBitrate
  ) {
    return `AudioBitrateNotSupported: ${source.bitrate}`;
  }

  for (const named of client.codecProfiles) {
    // A codec profile with no name is about every codec; one that names another
    // codec is not about this file at all.
    if (named.name !== '' && named.name !== source.codec) continue;
    for (const limitation of named.limitations) {
      if (!limitation.required) continue;
      if (holds(limitation, source) === false) return `LimitationNotMet: ${limitation.name}`;
    }
  }

  return null;
}

/**
 * What the client asked the answer to be, out of its own priority list.
 *
 * The transcoding profiles are an ordered list and the specification says the
 * server "should evaluate these in the order they are listed, as a priority
 * list", so the first one this server can actually produce wins.
 *
 * **A profile over any transport but `http` is skipped**, and that is the honest
 * reading of what this server is: it produces no HLS, and `requirements:47` puts
 * `hls` among the stubs. A client whose list is all HLS therefore gets no target
 * and `canTranscode: false`, which is a sentence it can act on — rather than a
 * `transcodeParams` that leads to a stream that never comes.
 */
function targetFor(client: ClientInfo, source: Source): TranscodeTarget | null {
  for (const profile of client.transcodingProfiles) {
    if (profile.protocol !== HTTP) continue;
    const format = formatFor(profile.container, profile.audioCodec);
    if (format === null) continue;
    return {
      format,
      maxBitRate: ceilingOf(client),
      maxChannels: channelsOf(profile, source),
    };
  }
  return null;
}

/**
 * The ceiling the client's own numbers put on the answer, in kilobits.
 *
 * The two fields are bits per second and mean different things: `maxAudioBitrate`
 * is what the client can handle at all, `maxTranscodingAudioBitrate` what it
 * will take a *converted* stream at. This is a converted stream, so the second
 * wins where it is given. Both are the protocol's "0 or missing means no
 * limitation", and neither is the protocol's `maxBitRate` — that one is in
 * kilobits and this one is in bits, which is a difference of a factor of a
 * thousand in a field nobody reads twice.
 */
function ceilingOf(client: ClientInfo): number | null {
  const bits = client.maxTranscodingAudioBitrate ?? client.maxAudioBitrate;
  if (bits === null || bits <= 0) return null;

  const kbps = Math.max(1, Math.round(bits / 1000));
  return kbps >= MAX_CEILING_KBPS ? null : kbps;
}

/**
 * The channel limit to pass down, which is only ever a limit on a *measured*
 * file.
 *
 * A client's `maxAudioChannels` is a ceiling, not a target — and this first
 * passed it down whenever the source's own count was unknown, on the reasoning
 * that a cap which cannot be shown to be unnecessary cannot be shown to be
 * needed either. **That reasoning was wrong, and live.** ffmpeg reads `-ac N` as
 * the number of channels to *produce*, so a stereo mp3 whose channel count
 * nobody had measured and a profile that said "no more than six" came out as
 * **5.1** — four channels invented for a client that had asked for no such
 * thing (measured on the operator's own Symfonium, task:2896). What the cap cost
 * was the audio and not the bytes: the answer is 52 MB with it and 51 MB
 * without, because a FLAC of a decoded mp3 is that size and no ceiling makes it
 * smaller.
 *
 * So the cap is passed only where the file is *known* to exceed it. Where the
 * count is unknown there is no cap, which is the same rule this module already
 * follows for a limitation it cannot evaluate — an unmeasured value is not a
 * breach — and the same one `alreadyIs` follows for a bitrate nobody measured.
 * What it costs: a file that really does hold six channels and was never
 * measured goes out as it is. This collection has **no** such file (measured:
 * zero of 3173 probes report more than two channels), so that is a hypothesis
 * about a library nobody here has.
 *
 * A cap at or above `MAX_CHANNELS` is not passed either, for the reason the
 * ceiling above is not: nothing can reach it. See `MAX_CHANNELS`.
 */
function channelsOf(profile: TranscodingProfile, source: Source): number | null {
  const cap = profile.maxAudioChannels;
  if (cap === null || cap <= 0 || cap >= MAX_CHANNELS) return null;
  if (source.channels === null || source.channels <= cap) return null;
  return cap;
}

/** What the answer will be, in the protocol's own words. */
function targetDetails(target: TranscodeTarget, source: Source): StreamDetails {
  const named = streamOf(target.format);
  if (named === null) throw new ApiError(ERROR.generic, `This server cannot describe ${target.format}`);

  // Sampling rate and channels survive a re-encode, so where the source's are
  // known the answer's are too — and where a cap is being passed it is the cap
  // that will be produced, whatever the file holds.
  const channels = target.maxChannels ?? source.channels;
  // The ceiling is reported only where it will be obeyed: `reencode` drops it on
  // a lossless target, and a target that says it is capped at 128 kbps and
  // arrives at 900 is the kind of promise this file exists not to make.
  const bitrate =
    target.maxBitRate === null || isLossless(target.format) ? null : target.maxBitRate * 1000;

  return {
    protocol: HTTP,
    container: named.container,
    codec: named.codec,
    ...(channels === null ? {} : { audioChannels: channels }),
    ...(bitrate === null ? {} : { audioBitrate: bitrate }),
    ...(source.samplerate === null ? {} : { audioSamplerate: source.samplerate }),
  };
}

// --- the token --------------------------------------------------------------

/**
 * The decision, in a form the client can hand back.
 *
 * **Self-contained and not a map with a time-to-live**, which the specification
 * explicitly allows ("should be kept valid by the server for a reasonable
 * duration *if stored in memory*"). Three reasons, in order of weight. A map
 * lives in a process, and this daemon is stopped and started constantly — no
 * autostart, and the end of an agent's session takes it down — while the client
 * is a phone that goes to the background and comes back an hour later. A map can
 * be *revoked*, and there is nothing here to revoke: the token names a transcode
 * setting, not a permission, and everything a forged one could ask for
 * (`format=mp3&maxBitRate=128`) a client can already ask for through `stream`.
 * And a map grows with every decision issued and never claimed.
 *
 * **So it is not signed, and that is a decision rather than an omission.** Every
 * field is parsed strictly against what this server would have issued — the
 * format against the closed list of `TARGETS`, the numbers against their bounds
 * — so a token nobody issued cannot name anything a client could not have named
 * on its own. A signature would buy the right to trust the value, and the value
 * is not trusted anyway.
 *
 * **The song is in it.** `getTranscodeStream` is given the `mediaId` as well, and
 * the token carries its own copy: the two disagreeing is a refusal rather than a
 * silent transcode of one song by another song's decision.
 *
 * It is *deterministic* — two identical decisions produce one identical token —
 * where the specification says "the value is unique". Nothing is lost by that:
 * the token is not an identity anywhere (the cache key is `keyOf`'s, from what
 * was asked for), no client can be shown to depend on two of them differing, and
 * the uniqueness the sentence is protecting — a value that cannot be confused
 * with another request's — is kept by the song and the settings being in it.
 * Recorded rather than left as a silent departure from a literal word.
 */
function issueToken(id: number, target: TranscodeTarget): string {
  const payload = [
    TOKEN_VERSION,
    id,
    target.format,
    target.maxBitRate ?? 0,
    target.maxChannels ?? 0,
  ];
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** The decision a client handed back, or a refusal naming what is wrong with it. */
function readToken(text: string, id: number): TranscodeTarget {
  const refuse = (why: string): never => {
    throw new ApiError(
      ERROR.generic,
      `transcodeParams is not one this server issued: ${why}. Ask getTranscodeDecision for one.`,
    );
  };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return refuse('it is not readable');
  }

  if (!Array.isArray(payload) || payload.length !== 5) return refuse('it is not a decision');
  const [version, media, format, kbps, channels] = payload as unknown[];

  if (version !== TOKEN_VERSION) return refuse(`it was issued by version ${String(version)}, not this one`);
  if (media !== id) return refuse('it was issued for another song');
  if (typeof format !== 'string' || streamOf(format) === null) {
    return refuse(`this server makes no ${String(format)}`);
  }
  if (
    typeof kbps !== 'number' ||
    !Number.isInteger(kbps) ||
    kbps < 0 ||
    kbps >= MAX_CEILING_KBPS
  ) {
    return refuse('its bitrate is not one this server would have issued');
  }
  // The same bound at both ends, and that is the point: everything `issueToken`
  // can write, this reads — and nothing else. `channelsOf` never passes a cap at
  // or above `MAX_CHANNELS`, so the two sets are exactly each other.
  if (
    typeof channels !== 'number' ||
    !Number.isInteger(channels) ||
    channels < 0 ||
    channels >= MAX_CHANNELS
  ) {
    return refuse('its channel count is not one this server would have issued');
  }

  return { format, maxBitRate: kbps === 0 ? null : kbps, maxChannels: channels === 0 ? null : channels };
}

// --- the routes -------------------------------------------------------------

/**
 * The song a `mediaId` names.
 *
 * `mediaId` and not `id`: these are the protocol's only two methods that spell
 * it that way, and a server reading `id` here would refuse every call the
 * specification describes. The form of the value is the one every other id in
 * this API takes — `tr:123` — so it is parsed by the same function.
 */
function mediaIdOf(query: URLSearchParams): number {
  const raw = required(query, 'mediaId');
  const parsed = parseId(raw);
  if (parsed === undefined || parsed.kind !== 'tr') {
    throw new ApiError(ERROR.notFound, `No such media: ${raw}`);
  }
  return parsed.n;
}

/**
 * The `mediaType` parameter, checked.
 *
 * Required by the specification, and its two values are `song` and `podcast`.
 * This server has no podcasts and no way to acquire one: a `mediaId` is a track
 * id and a podcast has none. So a client asking about a podcast is told there is
 * no such media, which is true, rather than handed a decision about a song.
 */
function mediaTypeOf(query: URLSearchParams): void {
  const type = required(query, 'mediaType');
  if (type !== 'song') {
    throw new ApiError(ERROR.notFound, `This server has no ${type} media: mediaId names a song`);
  }
}

/**
 * `getTranscodeDecision` — what this server would do with this song for this
 * client.
 *
 * The body is the `ClientInfo`; `mediaId` and `mediaType` are in the query,
 * which is what the specification's own example URL shows despite its body being
 * where the interesting half of the request lives.
 */
export async function getTranscodeDecision(context: RouteContext): Promise<Payload> {
  const id = mediaIdOf(context.query);
  mediaTypeOf(context.query);
  const client = clientInfoOf(context.body);

  const row = song(context.db, id);
  if (row === undefined) throw new ApiError(ERROR.notFound, `No such song: ${id}`);

  // Asked of the file where the scan's own reading is not a codec this server
  // knows — a `.m4a` is AAC or ALAC and only the file says which, which is 1425
  // of this collection's files. It is the same reading `stream` takes before it
  // sends such a file, cached the same way, so the two agree by construction.
  const path = join(row.root_path, row.rel_path);
  const codec = await codecOf(path, row.ext, row.codec);
  if (codec === null) {
    // `StreamDetails.codec` is `Req. Yes`, and this is the one place where that
    // cannot be honoured. Answering with the container's name instead is exactly
    // the defect migration 015 was written to undo: `codec` was filled with
    // `mp4` for two thousand files, and every one of them was a wrong answer
    // that looked like a right one.
    throw new ApiError(
      ERROR.generic,
      `This server could not read the audio of ${row.rel_path}, so it cannot say how it would be played`,
    );
  }

  const source: Source = {
    container: containerOf(row.ext),
    codec,
    channels: row.channels,
    samplerate: row.sample_rate,
    bitrate: bitrateOf(row),
  };

  const refusals = client.directPlayProfiles.map((profile) =>
    refusesProfile(profile, client, source),
  );
  // Both halves: some profile has to accept the file, *and* the server has to be
  // willing to send it as it is. A client that sent no profiles accepts nothing.
  const canDirectPlay = refusals.some((refusal) => refusal === null) && handsOver(row, codec);

  // **One string per direct-play profile, in the order the client sent them**,
  // which is the shape the specification asks for ("the server should return 1
  // string per direct play profile") — and the reason for that shape is that the
  // position *is* the profile: a reader holding a sentence and a list of
  // capabilities has nothing else to correlate the two by. A profile that
  // accepted gets the server's own reason where the server will re-encode
  // anyway, that being the reason which applies to it.
  //
  // **Empty when direct play is fine**, and that is not an optimisation: the
  // field is "reasons why transcoding is necessary", so a decision saying
  // `canDirectPlay: true` beside a list of reasons tells a client two things at
  // once, and the list is the half it acts on. A client carries several profiles
  // and all but one of them refuse any given file, so this was the ordinary case
  // rather than a corner (found live: a FLAC file against Symfonium's three
  // profiles answered `canDirectPlay: true` with two refusals beside it).
  //
  // A client that sent no profiles gets no entries — there is no profile to
  // explain, and `canDirectPlay: false` is the whole of the answer to it.
  const reasons = canDirectPlay
    ? []
    : refusals.map((refusal) => refusal ?? whyServerReencodes(row, codec));

  const target = targetFor(client, source);
  const decision: Decision = {
    canDirectPlay,
    canTranscode: target !== null,
    sourceStream: detailsOf(source),
    ...(reasons.length === 0 ? {} : { transcodeReason: reasons }),
  };

  if (target === null) {
    // **Only where something actually went wrong.** `errorReason` is "a
    // description of an error that occurred", and a client whose direct-play
    // profile works while it named no transcoding profile has been granted
    // exactly what it asked for: an error beside `canDirectPlay: true` is the
    // same false statement the reasons above are not allowed to make (found by
    // the contract axis, which read the same field's documentation).
    if (!canDirectPlay) {
      decision.errorReason =
        client.transcodingProfiles.length === 0
          ? 'The client named no transcoding profiles'
          : 'This server produces no stream over any transport but http, and no profile the client named is one it can make';
    }
  } else {
    decision.transcodeParams = issueToken(id, target);
    decision.transcodeStream = targetDetails(target, source);
  }

  return { transcodeDecision: decision };
}

/**
 * The `offset` parameter: seconds into the song, and nought by default.
 *
 * Not `timeOffset` — this extension spells the same idea its own way, which is
 * the one place the two spellings meet. `stream`'s is a client's offset on a
 * song; this is a decision's.
 */
function offsetOf(query: URLSearchParams): number | null {
  const raw = query.get('offset');
  if (raw === null || raw === '') return null;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new ApiError(ERROR.generic, `offset is not an offset: ${raw}`);
  }
  return seconds === 0 ? null : seconds * 1000;
}

/**
 * `getTranscodeStream` — the stream the decision decided on.
 *
 * The bytes are `serveSong`'s, which is `stream`'s own path: a client that got
 * `transcodeParams` from the decision and a client that named `format` in the
 * query get the same answer out of the same code, and the cache entry is the
 * same entry.
 *
 * **`transcodeParams` is the only thing that says what to make.** `mediaId` is
 * here too and is checked against the token rather than used to decide anything
 * — the specification says a client "should not try to reconstruct the
 * `transcodeParams`", and the way to mean that is to give the token no
 * competition.
 *
 * **A refusal here carries a status, and this is the only route that does.** Its
 * page asks for it in as many words — "In case of an error, a standard HTTP
 * error code is returned with a descriptive message" — and the OpenAPI document
 * declares 400, 401, 404 and 500 beside it. Every other byte route of this
 * server answers a refusal the way `send` documents, from `stream` and
 * `download` to the three stubbed ones, because a Subsonic client reads `status`
 * out of the body; this one method is the exception, and `STATUS_REFUSALS` in
 * `server.ts` is where the exception is drawn and where the argument for it is
 * written out (task:2913).
 *
 * The envelope is the body either way: the status is *added*, not substituted,
 * so a client that reads the code and the message still finds both.
 */
export async function getTranscodeStream(
  context: RouteContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const id = mediaIdOf(context.query);
  mediaTypeOf(context.query);

  // Deferred, like `stream`'s parameters: the token is read after the song is
  // looked up, so that a request naming an id that is not there is told that
  // rather than told about its token. One order for both routes into `serveSong`.
  await serveSong(context, request, response, {
    id,
    asked: () => readToken(required(context.query, 'transcodeParams'), id),
    offsetMs: () => offsetOf(context.query),
  });
}
