/**
 * The ID3v1 genre list, and the references that point into it.
 *
 * An ID3v2 genre is not always a word. Section 4.2.1 lets it be a reference to
 * this list — `"(17)"` means Rock, and v2.4 writes the same reference as a bare
 * number — so a reader that stores the string stores a number where a genre
 * belongs. The collection is full of them: of 700 mp3 files here, 105 carry
 * `"(52)Electronic"` or `"(17)"`, and a FLAC beside them states its genre in
 * plain words, so the reference would be the one shape of genre the meta layer
 * could not read.
 *
 * The table is taken from the sources and not retyped, and three of them are
 * compared against each other: Appendix A of v2.3 (0..125, labelling 80..125
 * "Winamp extensions"), Appendix A of v2.4 (0..79), and the official ID3v1 test
 * suite's generation log (0..255) — Martin Nilsson's generator, by the author of
 * the specification. They agree on 124 of the first 126 entries word for word.
 * The two exceptions are spelling: entry 67, where v2.3 repeats ID3v1's original
 * misspelling and v2.4 corrects it, and entry 123, where the appendix has
 * A cappella and the suite A capella. The appendix's spelling is kept where the
 * two appendices agree, and v2.4's where they do not.
 *
 * 126..147 come from the suite alone, which is the only source here that names
 * them. Past 147 it names nothing, and the one list that goes further is
 * ffmpeg's own — an implementation, not a text — so the table stops where the
 * sources do and a reference it cannot answer stays the string the file wrote.
 */

/**
 * Index is the reference: `ID3V1_GENRES[17]` is Rock.
 *
 * Exported because the list is not ID3's alone — an MP4 carries the same
 * numbering in its `gnre` atom, one-based, and a reader of it needs this table
 * rather than a second copy of it.
 */
export const ID3V1_GENRES: readonly string[] = [
  'Blues',           'Classic Rock',    'Country',
  'Dance',           'Disco',           'Funk',
  'Grunge',          'Hip-Hop',         'Jazz',
  'Metal',           'New Age',         'Oldies',
  'Other',           'Pop',             'R&B',
  'Rap',             'Reggae',          'Rock',
  'Techno',          'Industrial',      'Alternative',
  'Ska',             'Death Metal',     'Pranks',
  'Soundtrack',      'Euro-Techno',     'Ambient',
  'Trip-Hop',        'Vocal',           'Jazz+Funk',
  'Fusion',          'Trance',          'Classical',
  'Instrumental',    'Acid',            'House',
  'Game',            'Sound Clip',      'Gospel',
  'Noise',           'AlternRock',      'Bass',
  'Soul',            'Punk',            'Space',
  'Meditative',      'Instrumental Pop','Instrumental Rock',
  'Ethnic',          'Gothic',          'Darkwave',
  'Techno-Industrial','Electronic',      'Pop-Folk',
  'Eurodance',       'Dream',           'Southern Rock',
  'Comedy',          'Cult',            'Gangsta',
  'Top 40',          'Christian Rap',   'Pop/Funk',
  'Jungle',          'Native American', 'Cabaret',
  'New Wave',        'Psychedelic',     'Rave',
  'Showtunes',       'Trailer',         'Lo-Fi',
  'Tribal',          'Acid Punk',       'Acid Jazz',
  'Polka',           'Retro',           'Musical',
  'Rock & Roll',     'Hard Rock',       'Folk',
  'Folk-Rock',       'National Folk',   'Swing',
  'Fast Fusion',     'Bebob',           'Latin',
  'Revival',         'Celtic',          'Bluegrass',
  'Avantgarde',      'Gothic Rock',     'Progressive Rock',
  'Psychedelic Rock','Symphonic Rock',  'Slow Rock',
  'Big Band',        'Chorus',          'Easy Listening',
  'Acoustic',        'Humour',          'Speech',
  'Chanson',         'Opera',           'Chamber Music',
  'Sonata',          'Symphony',        'Booty Bass',
  'Primus',          'Porn Groove',     'Satire',
  'Slow Jam',        'Club',            'Tango',
  'Samba',           'Folklore',        'Ballad',
  'Power Ballad',    'Rhythmic Soul',   'Freestyle',
  'Duet',            'Punk Rock',       'Drum Solo',
  'A cappella',      'Euro-House',      'Dance Hall',
  'Goa',             'Drum & Bass',     'Club-House',
  'Hardcore',        'Terror',          'Indie',
  'BritPop',         'Negerpunk',       'Polsk Punk',
  'Beat',            'Christian',       'Heavy Metal',
  'Black Metal',     'Crossover',       'Contemporary',
  'Christian Rock',  'Merengue',        'Salsa',
  'Thrash Metal',    'Anime',           'JPop',
  'Synthpop',
];

/**
 * The two content types the list does not number.
 *
 * Section 4.2.1 defines them beside the numeric references and says they work
 * the same way; v2.4 writes them without brackets. ffprobe leaves `(RX)` as
 * typed, which is a difference this reader takes deliberately: the
 * specification gives the string a meaning, and a reader that ignored it would
 * be storing a keyword as though it were a genre.
 */
const KEYWORD_GENRES: Record<string, string> = {
  RX: 'Remix',
  CR: 'Cover',
};

/**
 * A genre reference resolved to the genre, or the value unchanged.
 *
 * Unchanged is the answer for everything the specification does not describe:
 * a genre already written as a word, a reference the table cannot answer, a
 * bracket that does not close. Returning the value as it arrived is what keeps
 * this a decoding step rather than a guess — a reader with nothing to decode
 * must not be able to alter what it read.
 *
 * Everything after the closing bracket goes, refinement and all. That is
 * ffprobe's style — `"(4)Eurodisco"` reads Disco — and this project compares
 * itself against ffprobe, so the divergence is worth less than the agreement.
 */
export function resolveGenre(value: string): string {
  const bracketed = /^\(([^)]*)\)/.exec(value);
  const inner = bracketed?.[1] ?? value;

  const name = /^\d+$/.test(inner)
    ? ID3V1_GENRES[Number(inner)]
    : KEYWORD_GENRES[inner];

  // A bracket that opened but resolved to nothing leaves the whole value alone,
  // which is also what happens to a value with no bracket at all.
  if (name === undefined) return value;

  return name;
}
