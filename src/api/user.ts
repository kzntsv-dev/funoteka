import type { DatabaseSync } from '../db/index.ts';
import { ID } from './browse.ts';
import type { ServerConfig } from './config.ts';
import { ApiError, ERROR } from './envelope.ts';
import { roots } from './meta.ts';

/**
 * Who the caller is, as the protocol asks it.
 *
 * A client asks this on the way in — Feishin asks it before it will add a
 * server at all — and reads a record of roles out of the answer. This server
 * has exactly one user, the one it was configured with, and that user owns the
 * whole library: there is no sharing, no guest, and nothing a second account
 * could be refused, so every role is granted. Answering with a smaller set
 * would be describing a permission system that does not exist.
 *
 * What roles *mean* here is worth being plain about, since several of them name
 * features this server does not have: `shareRole`, `jukeboxRole` and
 * `videoConversionRole` are granted because the account is not restricted, not
 * because the features are implemented. A client that reads them as promises
 * will ask for something that is missing — and be refused by name, which is
 * this API's answer to everything it cannot do.
 *
 * `getUsers` answers the same record inside a list, and that is the operator's
 * call rather than the contract's. The contract put user *management* out of
 * scope — «users (кроме getUser)» among the stubs — and a stub answering an
 * empty list was written first. What that cost was visible in one session: a
 * client asks `getUsers` and is told the server has no users, then asks `getUser`
 * and is told about one. Asked which answer it should give, the operator said
 * this one. `wiki:3640` records the reversal; nothing else changed, because a
 * list of one is the same record.
 */
function record(db: DatabaseSync, config: ServerConfig): Record<string, unknown> {
  return {
      username: config.user,
      email: '',
      scrobblingEnabled: false,
      adminRole: true,
      settingsRole: true,
      downloadRole: true,
      uploadRole: true,
      playlistRole: true,
      coverArtRole: true,
      commentRole: true,
      podcastRole: true,
      streamRole: true,
      jukeboxRole: true,
      shareRole: true,
      videoConversionRole: true,
      // The music folders the account may read, by the same ids `getMusicFolders`
      // hands out: a client that filters a search by one has to be able to learn
      // which ones it is allowed to name.
      folder: roots(db).map((row) => ID.root(row.id)),
  };
}

export function getUser(db: DatabaseSync, config: ServerConfig, requested: string | null): Record<string, unknown> {
  // "Only the current user is allowed to be retrieved", the protocol says, and
  // the caller is already the configured one — so a name that is not that one
  // asks about an account this server has never heard of, and saying so is
  // truer than answering about somebody else.
  if (requested !== null && requested !== '' && requested !== config.user) {
    throw new ApiError(ERROR.notFound, `No such user: ${requested}`);
  }

  return { user: record(db, config) };
}

/**
 * Every account, which is the one there is.
 *
 * The protocol requires administrative rights for this method, and there is
 * nothing here for that to mean: the only account is the one that owns the
 * server, and it is granted every role (see above). A refusal would describe a
 * permission system this server does not have.
 */
export function getUsers(db: DatabaseSync, config: ServerConfig): Record<string, unknown> {
  return { users: { user: [record(db, config)] } };
}
