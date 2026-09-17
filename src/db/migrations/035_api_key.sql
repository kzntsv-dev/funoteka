-- The keys a client may present instead of a password, and the one that is not here.
--
-- The OpenSubsonic extension `apiKeyAuthentication` is not a parameter, it is a
-- pair of promises: a key that arrives is a whole credential, and a server that
-- accepts one **must** offer a way to see the keys it is accepting and to take
-- one back. This project honoured the first half from the beginning — the
-- parameter worked, once `auth.ts` stopped demanding `u` beside it — and had no
-- way at all to do the second: the key lived in a variable in `start.cmd`,
-- readable only by reading that file on the server, and revocable only by
-- editing it and restarting the daemon (task:2915).
--
-- So this is the registry that makes the second half true. A key added here can
-- be listed and revoked while the server is running, which is what taking a key
-- back from a device somebody lost has to mean.
--
-- **The environment's key is deliberately not in this table.** `FUNOTEKA_APIKEY`
-- stays exactly what it was — checked first, always valid — and it is the
-- credential that must survive a database. A key whose only copy lives in the
-- database cannot recover that database, and a bootstrap credential that
-- `revoke` could silently undo on the next restart would be worse than none. The
-- CLI reports it as what it is and says where it is revoked.
--
-- A revoked row is kept rather than deleted. Its `secret` stays under the unique
-- index, so a key that was taken back cannot be added again by accident and
-- quietly become valid — and "when was this taken back" is a question the
-- registry should be able to answer, which a deleted row cannot.
CREATE TABLE api_key (
  id         INTEGER PRIMARY KEY,
  -- What the person called it: "the tablet", "Symfonium on the phone". A key
  -- nobody can tell from another is a key nobody dares revoke.
  label      TEXT    NOT NULL,
  secret     TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  revoked_at TEXT
);

-- Unique across revoked rows too — see the note above.
CREATE UNIQUE INDEX api_key_secret ON api_key (secret);
