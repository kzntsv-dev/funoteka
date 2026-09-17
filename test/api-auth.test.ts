import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { authenticate, coverSignature } from '../src/api/auth.ts';
import type { ServerConfig } from '../src/api/config.ts';
import { createServer } from '../src/api/server.ts';
import { openDb } from '../src/db/index.ts';

type Db = ReturnType<typeof openDb>;

/** As much of an answer as these tests read. */
interface Envelope {
  'subsonic-response': {
    status: string;
    error?: { code: number; message: string };
  };
}

const answer = async (response: Response): Promise<Envelope['subsonic-response']> =>
  ((await response.json()) as Envelope)['subsonic-response'];

const CONFIG: ServerConfig = {
  dbPath: ':memory:',
  host: '127.0.0.1',
  port: 0,
  user: 'demo',
  password: 'sesame',
  apiKey: '',
  ffmpeg: 'ffmpeg',
    cacheDir: '/tmp/funoteka-cache-test',
  logFile: '',
  logRequests: false,
  cors: false,
  showJunk: false,
};

/** The protocol's token: the password and the salt, hashed together. */
function token(password: string, salt: string): string {
  return createHash('md5').update(`${password}${salt}`).digest('hex');
}

function query(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

/** What a refusal says, or `ok` when the credentials were accepted. */
function refusal(
  config: ServerConfig,
  fields: Record<string, string>,
  signedRoute = false,
): string {
  const verdict = authenticate(query(fields), config, signedRoute);
  return verdict.ok ? 'ok' : `${verdict.code}: ${verdict.message}`;
}

test('a password is accepted plain, and encoded as the protocol allows', () => {
  // `enc:` is how a client sends a password it would rather not put on the wire
  // as text. It is the same password: a server that read the hex as the password
  // would refuse every client that used it.
  assert.equal(refusal(CONFIG, { u: 'demo', p: 'sesame' }), 'ok');
  assert.equal(refusal(CONFIG, { u: 'demo', p: `enc:${Buffer.from('sesame').toString('hex')}` }), 'ok');
});

test('a salted token is accepted, and only against the salt it was made with', () => {
  const good = token('sesame', 'abc123');
  assert.equal(refusal(CONFIG, { u: 'demo', t: good, s: 'abc123' }), 'ok');

  // The salt is the client's, so the hash is only meaningful beside it. A token
  // that arrived with a different salt is a token for a different password.
  assert.match(refusal(CONFIG, { u: 'demo', t: good, s: 'other' }), /^40: /);
  // Hex has two cases and neither is wrong.
  assert.equal(refusal(CONFIG, { u: 'demo', t: good.toUpperCase(), s: 'abc123' }), 'ok');
});

test('an api key is accepted on its own, and only on its own', () => {
  // **This test was named for the specification's rule while sending the shape
  // that rule forbids.** The extension is emphatic: "When an API key is provided,
  // the client **must not** provide a `u` parameter; passing in `u` **must** be
  // treated as an error 43". The body here sent `u` beside the key and the server
  // accepted it, so the one form every client uses was the one form that could
  // not work — and the test could not see it, because it never sent the key
  // alone. Found by the operator bringing Symfonium up (task:2896).
  const withKey: ServerConfig = { ...CONFIG, apiKey: 'k-1234' };

  assert.equal(refusal(withKey, { apiKey: 'k-1234' }), 'ok');

  // A key is one way in, not a way round the password: a server with none
  // configured accepts none, rather than treating the empty string as one.
  assert.match(refusal(CONFIG, { apiKey: '' }), /^40: /);
  assert.match(refusal(CONFIG, { apiKey: 'k-1234' }), /^40: /);
  assert.match(refusal(withKey, { apiKey: 'k-1235' }), /^40: /);

  // And it arrives alone. With a user, or with any other mechanism, it is two
  // ways in at once — the protocol's own code 43, not a refusal about the secret.
  for (const beside of [{ u: 'demo' }, { p: 'sesame' }, { t: 'x', s: 'y' }] as Record<
    string,
    string
  >[]) {
    assert.match(
      refusal(withKey, { apiKey: 'k-1234', ...beside }),
      /^43: /,
      `apiKey with ${Object.keys(beside).join(', ')}`,
    );
  }
});

test('a picture link is a credential, and only for what it names', () => {
  // **The reason is measured.** An image loader does not authenticate: the
  // operator's Symfonium asks for an artist's picture with no `u`, `t` or `s`,
  // and a server that guards that route like the rest answers a refusal the
  // client can only draw a placeholder over (task:2916). Navidrome arrived at
  // the same answer for the same symptom — a signed URL for artist art.
  const withKey: ServerConfig = { ...CONFIG, apiKey: 'k-1234' };
  const sig = coverSignature('ar-9', withKey);

  // No user at all, which is the whole point of it.
  assert.equal(refusal(withKey, { id: 'ar-9', sig }, true), 'ok');

  // Not on a route that does not hand links out: the signature names its door,
  // so a signed picture link cannot be replayed as a signed `getArtist`.
  assert.match(refusal(withKey, { id: 'ar-9', sig }), /^10: /);

  // Not for another id, and not for a signature nobody issued.
  assert.match(refusal(withKey, { id: 'ar-10', sig }, true), /^40: /);
  assert.match(refusal(withKey, { id: 'ar-9', sig: 'not-a-signature' }, true), /^40: /);

  // An absent one is a missing parameter, like every other absent credential.
  assert.match(refusal(withKey, { id: 'ar-9' }, true), /^10: /);

  // And **changing the secret revokes every link ever handed out**, which is the
  // whole of what revocation has to be when nothing is stored.
  assert.match(refusal({ ...withKey, apiKey: 'k-9999' }, { id: 'ar-9', sig }, true), /^40: /);

  // A server with no key signs with its password, so a deployment that sets one
  // and not the other still hands out links that work.
  const passwordOnly: ServerConfig = { ...CONFIG, password: 'sesame' };
  assert.equal(
    refusal(passwordOnly, { id: 'ar-9', sig: coverSignature('ar-9', passwordOnly) }, true),
    'ok',
  );
});

test('the wrong password and the wrong user are refused the same way', () => {
  // A refusal that told the two apart would let anyone holding a password list
  // the collection's users, which is a thing to find out only with a password.
  const wrongPassword = refusal(CONFIG, { u: 'demo', p: 'wrong' });
  const wrongUser = refusal(CONFIG, { u: 'nobody', p: 'sesame' });

  assert.match(wrongPassword, /^40: /);
  assert.match(wrongUser, /^40: /);
  assert.equal(wrongPassword.split(': ')[1], wrongUser.split(': ')[1]);
});

test('credentials that are absent, or half given, are a missing parameter', () => {
  // Not "wrong password": the client built the request wrong, and the protocol
  // keeps a code for that so the two failures can be told apart in a log.
  assert.match(refusal(CONFIG, {}), /^10: /);
  assert.match(refusal(CONFIG, { u: 'demo' }), /^10: /);
  assert.match(refusal(CONFIG, { p: 'sesame' }), /^10: .*u/);
  // A token without its salt cannot be checked at all, so it is not a wrong
  // token — it is a request that did not finish arriving.
  assert.match(refusal(CONFIG, { u: 'demo', t: token('sesame', 'x') }), /^10: .*s/);
  assert.match(refusal(CONFIG, { u: 'demo', s: 'x' }), /^10: .*t/);
});

test('two ways in at once are refused rather than picked between', () => {
  // Whichever the server chose, a client that sent both believes it used the
  // other, and the difference would only surface as a mystery refusal later.
  const both = refusal(CONFIG, { u: 'demo', p: 'sesame', apiKey: 'k' });
  assert.match(both, /^43: /);

  const tokenAndPassword = refusal(CONFIG, {
    u: 'demo',
    p: 'sesame',
    t: token('sesame', 'x'),
    s: 'x',
  });
  assert.match(tokenAndPassword, /^43: /);
});

test('a server with no credentials cannot be built', () => {
  // The failure this prevents is a music library answering anyone who asks. It
  // is caught where the server comes into being, so no test and no deployment
  // can hold one that authenticates nobody.
  const db = openDb(':memory:');
  assert.throws(
    () => createServer(db, { ...CONFIG, user: '', password: '', apiKey: '' }),
    /credentials/,
  );
  db.close();
});

test('an unauthenticated caller is refused before the method is even looked at', () => {
  // Otherwise the refusals would spell out which methods exist, and a stranger
  // on the network could read the server's surface without a password.
  const db = openDb(':memory:');
  const server = createServer(db, CONFIG);
  return new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address() as AddressInfo;
        const base = `http://127.0.0.1:${port}/rest`;

        const bare = await answer(await fetch(`${base}/ping?f=json`));
        assert.equal(bare.status, 'failed');
        assert.equal(bare.error?.code, 10);

        // A method that does not exist, so that what is checked is the order of
        // the two refusals: the credentials are judged before the method is
        // looked up, and a stranger learns nothing about the library.
        const unknown = await answer(await fetch(`${base}/getPodcasts?f=json`));
        assert.equal(
          unknown.error?.message.includes('getPodcasts'),
          false,
          'a stranger is not told whether the method exists',
        );

        const wrong = await answer(await fetch(`${base}/ping?f=json&u=demo&p=nope`));
        assert.equal(wrong.error?.code, 40);

        const right = await answer(await fetch(`${base}/ping?f=json&u=demo&p=sesame`));
        assert.equal(right.status, 'ok');

        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
        db.close();
      }
    });
  });
});
