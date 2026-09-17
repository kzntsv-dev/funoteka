-- What a mutation answered, kept by the key the caller gave it.
--
-- A control surface is called by an agent or a script over a network, and a
-- network gives two answers that look alike from the caller's side: the request
-- that was never received, and the answer that was lost on the way back. A
-- caller that retries cannot tell them apart, and for `config set` a retry is
-- harmless while for a rotation it is not. An `Idempotency-Key` header is how
-- the caller says "this is the same request", and this table is where the first
-- answer is kept so the second one can be given it instead of doing the work
-- twice.
--
-- In the database rather than in memory, and that is not a detail: `POST
-- /restart` exists, it is in this same surface, and a server that had just
-- restarted would have forgotten every key it had ever been given — which is
-- exactly the moment a client retries.
--
-- The body is stored as the text that was sent, with its status, because a
-- replay has to be indistinguishable from the answer it repeats: a caller that
-- got a different body the second time would be right to conclude the operation
-- ran twice.
CREATE TABLE admin_idempotency (
  key        TEXT PRIMARY KEY,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  status     INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Pruning is by age, and age is the only thing it is ever asked for.
CREATE INDEX admin_idempotency_age ON admin_idempotency (created_at);
