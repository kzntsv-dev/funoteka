/**
 * Which of a folder's pictures is the cover.
 *
 * A rip carries more than one image — the front, the back, the disc, the
 * booklet, a matrix photograph — and the protocol asks for "the cover art",
 * singular. So one of them has to be chosen, and the choice has to be a
 * function of what the folder holds rather than of the order the filesystem
 * happened to hand the walk.
 *
 * The words below are not a guess about what rips are called in general. They
 * are what this collection actually uses: across the scanned sample the names
 * that mean "this is the front" are `front` and `cover`, and beside them sit
 * `back`, `cd`, `cd matrix`, `booklet 1`, `obi`, `jap. booklet`, `text`, `box`
 * and the plain numbered scans — none of which may win. A picture whose name
 * says nothing (`001.jpg`) is not wrong to serve, but it may not displace one
 * that says "front".
 *
 * Ranking is by the first word of the name and nothing else, which is what
 * makes `front cover.jpg` and `front.jpg` the same answer while `cover back.jpg`
 * — a name that would defeat a rule reading the whole stem — is not a case this
 * collection produces. Adding words here is cheap; adding a rule is not.
 */
const FRONT_WORDS = ['front', 'cover', 'folder', 'album'] as const;

/**
 * The picture to serve for a folder, or nothing when it holds none.
 *
 * `pictures` is expected in path order — that is what `picturesInFolder` orders
 * by, and the fallback leans on it: a folder with no telling name is read from
 * its first picture, which is a decision anyone can reproduce by listing the
 * folder rather than one that depends on how the disk was walked.
 */
export function pickCover<T extends { rel_path: string }>(pictures: readonly T[]): T | undefined {
  let chosen: T | undefined;
  let chosenRank: number = FRONT_WORDS.length;

  for (const picture of pictures) {
    const rank = FRONT_WORDS.indexOf(firstWord(picture.rel_path) as (typeof FRONT_WORDS)[number]);
    if (rank !== -1 && rank < chosenRank) {
      chosen = picture;
      chosenRank = rank;
    }
  }

  return chosen ?? pictures[0];
}

/**
 * The word a picture's name starts with — `front` for `front cover.jpg`,
 * `cd` for `cd matrix.jpg`, `001` for `001.jpg`.
 *
 * The extension is dropped before the split so that a file named `cover.mp3.jpg`
 * is not read as a name about mp3, and the split is on the separators a file
 * name actually uses, which leaves `front_cover.jpg` and `front-cover.jpg`
 * saying the same thing as `front cover.jpg`.
 */
function firstWord(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  return stem.toLowerCase().split(/[^\p{L}\p{N}]+/u)[0] ?? '';
}
