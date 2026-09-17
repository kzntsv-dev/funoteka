/**
 * What an artist's `.nfo` says about them.
 *
 * The collection keeps a note about an artist in the folder named for them —
 * `The Cure/artist.nfo`, written by Jellyfin — and it is the only offline
 * source of a biography this project has. The scan records `.nfo` files as
 * files and never parses them: their text is not in the meta layer, so it is
 * read out of the document at the point a client asks, which is what makes this
 * a reader rather than a column.
 *
 * It is not an XML parser and does not pretend to be. The documents this
 * collection holds are the ones Jellyfin writes, and this reads the two things
 * about them that matter: a tag's text, and the five entities XML defines. A
 * document that needed more than that would need a parser, and adding one
 * before there is a document to justify it would be guessing at the shape of
 * the problem.
 */

/** The text a document holds between one tag's opening and its closing. */
function elementText(xml: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  const from = xml.indexOf(open);
  if (from === -1) return null;

  const to = xml.indexOf(close, from + open.length);
  if (to === -1) return null;

  return xml.slice(from + open.length, to);
}

/** The last code point Unicode has, which is also the last XML allows. */
const LAST_CODE_POINT = 0x10ffff;

/** The surrogate range: a pair's halves, never a character on its own. */
const SURROGATES = { from: 0xd800, to: 0xdfff };

/**
 * Whether a number names a character XML has — which is not every number
 * Unicode does.
 *
 * `Char` is what the format permits in a document, and it excludes the
 * surrogates (each is half of a pair) and everything past the last plane.
 * `String.fromCodePoint` refuses only the second of those, so the first is
 * checked here rather than left to it: a lone surrogate that reached the XML
 * envelope would be a document no reader could parse.
 */
function isXmlChar(point: number): boolean {
  if (!Number.isInteger(point) || point < 0 || point > LAST_CODE_POINT) return false;
  return point < SURROGATES.from || point > SURROGATES.to;
}

/**
 * The text with its entities resolved — `Siouxsie &amp; the Banshees` read as
 * a client should show it.
 *
 * Named and numeric alike, because a document may spell an ampersand either
 * way and both mean the same thing to a reader. Anything that is not an entity
 * this reader can resolve is left exactly as it was written, and that includes
 * a numeric one naming no XML character: `&#1114112;` is not a character, so
 * there is nothing to resolve it to, and a bare `&` is not this reader's to
 * fix. Leaving the text is also what keeps this total — a note read off disk
 * is somebody else's file, and a malformed one must not be able to throw out
 * of a pure reader that answers with text.
 */
function unescapeXml(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (whole, dec: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (dec !== undefined || hex !== undefined) {
        const point = dec !== undefined ? Number(dec) : parseInt(hex ?? '', 16);
        return isXmlChar(point) ? String.fromCodePoint(point) : whole;
      }

      switch (named) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return whole;
      }
    },
  );
}

/**
 * The artist's biography, or nothing when the document does not hold one.
 *
 * A document with no `<biography>` has no biography — an `<outline>` beside it
 * is a summary and is not the same claim, so it is not offered in its place.
 * Whitespace around the text is the document's layout rather than its content
 * and goes; the lines inside it are the author's and stay.
 *
 * Empty is nothing. A caller that has to check for an empty string before
 * showing it is a caller doing this reader's job.
 */
export function biographyOf(xml: string): string | null {
  const raw = elementText(xml, 'biography');
  if (raw === null) return null;

  const text = unescapeXml(raw).trim();
  return text === '' ? null : text;
}
