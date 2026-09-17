import { test } from 'node:test';
import assert from 'node:assert/strict';

import { discSubtitle, folderNote, parseFolderName, recordTitle, recordVersion, unsaidNote } from '../src/classify/folder-name.ts';

test('the artist-first form with the year last gives up all three parts', () => {
  // A fourth grammar, and the collection states it in full:
  // `The Cure - Assemblage - 1991 (12CD FLAC)`. The Discogs form puts the year
  // first, this one puts it last, and the difference is provable the same way
  // the second grammar's is: a year written *after* two other segments is not
  // where a year goes in `год - кредит - заголовок`, so the first segment is
  // the credit, the ones between it are the title, and the year is the year.
  //
  // The disc count is also why the note went unread: `\bcd\b` cannot match
  // inside `12CD`, because no word boundary falls between a digit and a letter.
  assert.deepEqual(parseFolderName('The Cure - Assemblage - 1991 (12CD FLAC)'), {
    year: 1991,
    credit: 'The Cure',
    title: 'Assemblage',
    format: '12CD FLAC',
  });

  // A count in a title of several words, so the trailing slot is not the only
  // thing the branch reads.
  assert.deepEqual(parseFolderName('Blur - Parklife - 1994 (2CD FLAC)'), {
    year: 1994,
    credit: 'Blur',
    title: 'Parklife',
    format: '2CD FLAC',
  });
});

test('a disc count inside brackets is a format note', () => {
  // `(Cass, C60)` proved itself with a comma and `(JPN Remastered)` with a word.
  // A count proves itself with neither: `12CD FLAC` names the medium as plainly
  // as `CD` does, and only the word-boundary rule kept it out.
  assert.equal(parseFolderName('1993 - Show (2CD)').format, '2CD');
  assert.equal(parseFolderName('1993 - Show (2CD FLAC)').format, '2CD FLAC');

  // A number that is not a count is still not a format.
  assert.equal(parseFolderName('1992 - Opiate (61422-31027-2)').format, null);
});

test('the Discogs-style folder gives up all four of its parts', () => {
  // The shape the whole rule exists for: year, credit, title, format.
  assert.deepEqual(parseFolderName('1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)'), {
    year: 1994,
    credit: 'Cock E.S.P. + Thirdorgan',
    title: 'Split',
    format: 'Cass, C60',
  });
});

test('every real credit on the sample is found', () => {
  const credits: [string, string][] = [
    ['1995 - Grace Brother + Cock E.S.P. - Split (Cass)', 'Grace Brother + Cock E.S.P.'],
    ['1996 - Aube + Cock E.S.P. - Maschinenwerk (CD, Album, Ltd)', 'Aube + Cock E.S.P.'],
    ['1999 - Merzbow + Cock E.S.P. - Music For Man With No Name (CD)', 'Merzbow + Cock E.S.P.'],
    ['2000 - The Nihilist Spasm Band + Cock E.S.P. - Split (CDr, B-card)', 'The Nihilist Spasm Band + Cock E.S.P.'],
    ['2006 - Cock E.S.P. + OVO - Split (7, Ltd)', 'Cock E.S.P. + OVO'],
    ['2011 - Arvo Zylo + Cock E.S.P. - Fuck E.S.P. (Cass, Ltd, C20)', 'Arvo Zylo + Cock E.S.P.'],
  ];

  for (const [folder, credit] of credits) {
    assert.equal(parseFolderName(folder).credit, credit, folder);
  }
});

test('a folder with no credit does not invent one', () => {
  // Two segments after the year slot is what a credit looks like; one is a
  // title, and reading it as a credit would name the album after itself.
  assert.deepEqual(parseFolderName('1996 - Greatest Dicks (CD, Comp)'), {
    year: 1996,
    credit: null,
    title: 'Greatest Dicks',
    format: 'CD, Comp',
  });
  assert.equal(parseFolderName('1997 - Menasha Red Light District (CD, Album, Ltd)').credit, null);
});

test('a credit with no title is still a credit', () => {
  // The joiner is the only signal here, and it is enough.
  assert.deepEqual(parseFolderName('2009 - Twodeadsluts Onegoodfuck + Cock E.S.P. (Cass, Ltd, C5)'), {
    year: 2009,
    credit: 'Twodeadsluts Onegoodfuck + Cock E.S.P.',
    title: null,
    format: 'Cass, Ltd, C5',
  });
});

test('a lone segment is not a credit just because it carries a joiner', () => {
  // The test above is the whole justification for reading a credit off a joiner
  // with no title left beside it — and it is a good one, because `2009 - A + B
  // (Cass, Ltd, C5)` is the Discogs form with its title slot missing, and `+`
  // between two names is what this collection writes a split with.
  //
  // But the branch fires on the *first* segment of any name, so a title that
  // merely contains `&` is claimed as an artist too. Measured on the live
  // collection: the branch fires on six names and five of them are wrong — a
  // year range in a title, a volume number, a disc marker, a catalogue number.
  // One of those five is the only garbage artist the meta layer holds.
  //
  // A credit is a list of *names*, and a name carries no number. That is the
  // whole of the guard, and it is asked only when nothing is left to be a
  // title: where a title survives, the joiner has already proved itself.
  const titles: [string, string][] = [
    [
      '2004 - Join The Dots B-Sides & Rarities 1978-2001 The Fiction Years [EU Polydor 981 463-0]',
      'Join The Dots B-Sides & Rarities 1978-2001 The Fiction Years',
    ],
    [
      '2015 - Saint-Germain-des-Prés Café, Vol. 17 _ The Best Electronic, Lounge, Trip-Hop & Hip-Hop Playlist from Paris',
      'Saint-Germain-des-Prés Café, Vol. 17 _ The Best Electronic, Lounge, Trip-Hop & Hip-Hop Playlist from Paris',
    ],
    [
      '1987 ● ДК «Невский» `87 & VI фестиваль ЛРК `88 (2021, Maschina Records, MASHCD-058-2)',
      'ДК «Невский» `87 & VI фестиваль ЛРК `88',
    ],
  ];

  for (const [name, title] of titles) {
    const parsed = parseFolderName(name);
    assert.equal(parsed.credit, null, `${title} is a title, not a credit`);
    assert.equal(parsed.title, title, 'and it survives whole');
  }

  // A disc folder reaches the same branch with no year slot at all.
  assert.equal(parseFolderName('CD2 ● Live `84 & `86').credit, null);
});

test('xxxx is a year slot without a year', () => {
  const parsed = parseFolderName('xxxx - Public Apology (Cass)');

  assert.equal(parsed.year, null);
  assert.equal(parsed.credit, null);
  assert.equal(parsed.title, 'Public Apology');
});

test('a credit is claimed only behind a year slot or a joiner', () => {
  // These four are the reason the rule is narrow. A prototype that claimed a
  // credit from any `A - B` produced a credit for all four, and every one is
  // wrong: a title with a dash, a disc, an artist-first grammar, and an album
  // whose artist is simply its name.
  assert.equal(parseFolderName('Pink Floyd - The Wall (JPN Remastered)').credit, null);
  assert.equal(parseFolderName('The Gerogerigegege - 2016 - 燃えない灰 (Moenai Hai)').credit, null);
  assert.equal(parseFolderName('CD 2 - Disk Union Bonus').credit, null);
  assert.equal(parseFolderName('This Is a Title - With a Dash').credit, null);
});

test('an artist-first folder gives up its artist and its year', () => {
  // The second grammar, and it is genuinely a different one: here the artist
  // sits where the year sits in `1994 - Кредит - Заголовок`. A year slot in the
  // *middle* is the proof — nobody writes a year second in a name that opens
  // with the title — so this needs no outside knowledge.
  assert.deepEqual(parseFolderName('The Gerogerigegege - 2016 - 燃えない灰 (Moenai Hai)'), {
    year: 2016,
    credit: null,
    title: '燃えない灰 (Moenai Hai)',
    format: null,
  });
});

test('the artist-first branch claims no credit', () => {
  // [[task:2684]] verified its result byte for byte. Letting this branch fill
  // `credit` would move Gerogerigegege's credit_source from `tag` to `folder`
  // retroactively — a change this task has no business making.
  const parsed = parseFolderName(
    'The Gerogerigegege - 2022 - 今日という日が生まれた時から決まっているように',
  );

  assert.equal(parsed.credit, null);
  assert.equal(parsed.year, 2022);
  assert.equal(parsed.title, '今日という日が生まれた時から決まっているように');
});

test('with no year in the middle the artist rule does not fire', () => {
  // Where the proof is absent the rule must stay quiet. `Артист - Заголовок` is
  // indistinguishable from `Заголовок - Подзаголовок`, and guessing costs a
  // title that was already right.
  assert.equal(parseFolderName('Pink Floyd - The Wall (JPN Remastered)').title, 'Pink Floyd - The Wall');
  assert.equal(parseFolderName('This Is a Title - With a Dash').title, 'This Is a Title - With a Dash');
  assert.equal(parseFolderName('CD 2 - Disk Union Bonus').title, 'CD 2 - Disk Union Bonus');
});

test('the scene layout gives up its artist and its title', () => {
  // The one real sample, and it is the whole of the evidence: Kroogi hands the
  // record out as `Артист_-_Заголовок-ГГГГ-Сайт`. Read as one word, the name
  // cost both the artist and the album title, silently.
  assert.deepEqual(parseFolderName('Aquarium_-_Archangelsk-2011-Kroogi.com'), {
    year: 2011,
    credit: 'Aquarium',
    title: 'Archangelsk',
    format: null,
  });
});

test('a scene name with no year still splits', () => {
  const parsed = parseFolderName('Aquarium_-_Archangelsk');

  assert.equal(parsed.credit, 'Aquarium');
  assert.equal(parsed.title, 'Archangelsk');
  assert.equal(parsed.year, null);
});

test('a dash inside a scene title survives', () => {
  // The year is what ends the title, so a title carrying dashes of its own
  // keeps them; only the tail the scene fenced off is dropped.
  const parsed = parseFolderName('Artist_-_A-Title-2011-Group');

  assert.equal(parsed.credit, 'Artist');
  assert.equal(parsed.title, 'A-Title');
  assert.equal(parsed.year, 2011);
});

test('a year-first credit is still read as a credit, not as an artist', () => {
  // The two grammars must not be confused in the other direction either.
  const parsed = parseFolderName('1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)');

  assert.equal(parsed.credit, 'Cock E.S.P. + Thirdorgan');
  assert.equal(parsed.year, 1994);
  assert.equal(parsed.title, 'Split');
});

test('a release-type suffix is not a title, and what precedes it is not a credit', () => {
  // The third shape, and it cost a real album: `2009 - This Must Be It - EP` is
  // `YEAR - TITLE - TYPE`, not `YEAR - CREDIT - TITLE`. Read the second way it
  // named the album `EP` *and* invented an artist called `This Must Be It` —
  // and on `The Girl and the Robot - Single` the invented credit then split on
  // `and` and produced an artist called `The Girl`.
  assert.deepEqual(parseFolderName('2009 - This Must Be It - EP'), {
    year: 2009,
    credit: null,
    title: 'This Must Be It',
    format: null,
  });
  assert.equal(parseFolderName('2009 - The Girl and the Robot - Single').credit, null);
  assert.equal(parseFolderName('2009 - The Girl and the Robot - Single').title, 'The Girl and the Robot');
  assert.equal(parseFolderName('2012 - Running to the Sea - Single').title, 'Running to the Sea');
});

test('a disc marker is a qualifier, not a title, and not a credit', () => {
  // `2014 - .5 The Gray Chapter - CD 1 [JP - WPCR-16130]` is `YEAR - TITLE -
  // DISC [catalog]`. Read as `YEAR - CREDIT - TITLE` it invented an artist
  // called `.5 The Gray Chapter` — which is the album's own name.
  const parsed = parseFolderName('2014 - .5 The Gray Chapter - CD 1 [JP - WPCR-16130]');

  assert.equal(parsed.credit, null);
  assert.equal(parsed.title, '.5 The Gray Chapter');
  assert.equal(parseFolderName('2014 - .5 The Gray Chapter - CD 2 [JP - WPCR-16131]').credit, null);
});

test('a title that merely resembles a release word is still a title', () => {
  // `Split` is the name of the record here, not a format. Treating it as one
  // would take the credit away from all sixteen Cock E.S.P collaborations —
  // the exact case the credit rule exists for.
  const parsed = parseFolderName('1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)');

  assert.equal(parsed.credit, 'Cock E.S.P. + Thirdorgan');
  assert.equal(parsed.title, 'Split');
});

test('a dash inside brackets is not a field separator', () => {
  // `1999 - Slipknot [JP - RRCY-1104]` carries a catalog bracket that holds a
  // dash of its own. Splitting on it produced an artist called `Slipknot [JP`
  // and a title of `RRCY-1104]` — both from a bracket that means neither.
  //
  // A square bracket is a note, like every square one: what the collection writes
  // there is a pressing or a catalogue number. It reaches the name as well
  // (`recordTitle` appends it, so nothing is lost by reading it), and the dash
  // inside it never reaches the splitter — which is what this test is about.
  assert.deepEqual(parseFolderName('1999 - Slipknot [JP - RRCY-1104]'), {
    year: 1999,
    credit: null,
    title: 'Slipknot',
    format: 'JP - RRCY-1104',
  });
});

test('brackets of either kind hold their contents together', () => {
  // A bracket that is not a format keeps its dash rather than being torn apart.
  assert.equal(parseFolderName('2001 - Inni (Live - Bootleg)').title, 'Inni (Live - Bootleg)');

  // ...and the fields outside a bracket still split as they always did.
  assert.equal(parseFolderName('1994 - A - Title [x - y]').credit, 'A');
  assert.equal(parseFolderName('1994 - A - Title [x - y]').title, 'Title');
  assert.equal(parseFolderName('1994 - A - Title [x - y]').format, 'x - y');
});

test('a parenthesised name is not a format', () => {
  // The other half of the conservatism. `(Moenai Hai)` is half the title and
  // `(UK)` is a disambiguator; stripping either would silently damage a name
  // that is already correct — the one thing this task must not do.
  assert.deepEqual(parseFolderName('燃えない灰 (Moenai Hai)'), {
    year: null,
    credit: null,
    title: '燃えない灰 (Moenai Hai)',
    format: null,
  });
  assert.equal(parseFolderName('Nirvana (UK)').title, 'Nirvana (UK)');
  assert.equal(parseFolderName('Nirvana (UK)').format, null);
});

test('a format is recognised without a comma when it names a medium', () => {
  assert.equal(parseFolderName('1998 - Cockworld (CD, Enh)').format, 'CD, Enh');
  assert.equal(parseFolderName('1996 - Greatest Dicks (CD, Comp)').format, 'CD, Comp');
  assert.equal(parseFolderName('Pink Floyd - The Wall (JPN Remastered)').format, 'JPN Remastered');
  assert.equal(parseFolderName('2006 - Cock E.S.P. + OVO - Split (7, Ltd)').format, '7, Ltd');
});

test('names that are already clean come back untouched', () => {
  assert.deepEqual(parseFolderName('Green Desert'), {
    year: null,
    credit: null,
    title: 'Green Desert',
    format: null,
  });
  assert.deepEqual(parseFolderName('今日という日が生まれた時から決まっているように'), {
    year: null,
    credit: null,
    title: '今日という日が生まれた時から決まっているように',
    format: null,
  });
  assert.equal(parseFolderName('CD 1').credit, null);
});

test('nothing throws, whatever the folder is called', () => {
  for (const name of ['', '   ', '-', ' - ', '()', 'x (', '1994 - ', ' - - ']) {
    assert.doesNotThrow(() => parseFolderName(name), name);
  }
});

test('a year in front of a title is read when a dot joins them, not only a dash', () => {
  // The same statement in a different punctuation. It has to be read before the
  // dash grammar, because a name with no dash in it reaches that grammar as one
  // segment and finds no year slot at all — which is why Tool's whole catalogue
  // could not say when any of its records came out.
  const dotted = parseFolderName('1992. Opiate [61422-31027-2]');
  assert.equal(dotted.year, 1992);
  assert.equal(dotted.title, 'Opiate');

  const dashed = parseFolderName('1999 - Slipknot [JP - RRCY-1104]');
  assert.equal(dashed.year, 1999, 'and the form that was already read still is');
  assert.equal(dashed.title, 'Slipknot');
});

test('a year in front of a title is read when the bullet joins them too', () => {
  // The punctuation this collection actually writes. Unread, the year stayed in
  // the *title* and never reached the column that holds it, so every box in the
  // library was shown as `1988 ● Группа крови` with an empty `year`.
  const parsed = parseFolderName('1988 ● Группа крови (2019, Maschina Records, MKK881CD, 3CD)');
  assert.equal(parsed.year, 1988);
  assert.equal(parsed.title, 'Группа крови');
  assert.equal(parsed.format, '2019, Maschina Records, MKK881CD, 3CD', 'and the note is still read');
});

test('the name a record is shown by has no year in it, and keeps its note', () => {
  // The year leaves the name — the field exists for it. The note stays: it is
  // what tells one edition from another, and the client this library is read in
  // does not render `version`, so a note that lives only there is a note nobody
  // sees. A record genuinely called `1999` keeps its name: the rule wants a
  // separator after the digits, not four digits.
  assert.equal(
    recordTitle('1988 ● Группа крови (2019, Maschina Records, MKK881CD, 3CD)'),
    'Группа крови (Maschina Records, MKK881CD, 3CD)',
  );
  assert.equal(recordTitle('1992. Opiate [61422-31027-2]'), 'Opiate (61422-31027-2)');
  assert.equal(recordTitle('1999'), '1999');
  assert.equal(
    recordTitle('1989 Звезда по имени Солнце (2019, Maschina Records, MKM891CD, 3CD)'),
    'Звезда по имени Солнце (Maschina Records, MKM891CD, 3CD)',
  );
  // Nothing was separated out, so the name stands as it is rather than having
  // its note appended a second time.
  assert.equal(recordTitle('Кинохроники 2021/1982 (Maschina Records, MASHCD-099)'), 'Кинохроники 2021/1982 (Maschina Records, MASHCD-099)');
});

test('the note a record carries is offered as its version, without the reissue year', () => {
  assert.equal(recordVersion('1988 ● Группа крови (2019, Maschina Records, MKK881CD, 3CD)'), 'Maschina Records, MKK881CD, 3CD');
  assert.equal(recordVersion('.5: The Gray Chapter (Special Edition)'), 'Special Edition');
  assert.equal(recordVersion('Slipknot [JP - RRCY-1104]'), 'JP - RRCY-1104', 'a square bracket is a pressing');
  assert.equal(recordVersion('Opiate [61422-31027-2]'), '61422-31027-2', 'and a bare catalogue number is one');
  assert.equal(recordVersion('Kveikur'), null, 'and a name with no note has no version');
});

test('a disc names itself only when the name says more than the number', () => {
  assert.equal(discSubtitle('CD2 ● Ранний вариант'), 'Ранний вариант');
  assert.equal(discSubtitle('CD 2 - Disk Union Bonus'), 'Disk Union Bonus');
  assert.equal(discSubtitle('CD1 ● Альбом'), 'Альбом');
  assert.equal(discSubtitle('CD1'), null, 'a disc called nothing but its number has no subtitle');

  // A box whose discs are named after the albums on them is numbered rather
  // than marked, and that shape went unread until the box itself was. All
  // twelve discs of `The Cure - Assemblage - 1991 (12CD FLAC)` were labelled
  // with the record's name and nothing else, so the album each one holds
  // appeared nowhere at all.
  assert.equal(discSubtitle('01 - Three Imaginary Boys (1979)'), 'Three Imaginary Boys (1979)');
  assert.equal(discSubtitle('12 - Disintegration (1989)'), 'Disintegration (1989)');

  // An ordinal needs its separator and something after it: `1999` is a title.
  assert.equal(discSubtitle('1999'), '1999');

  // A name with no marker is the name it is. Whether it says anything the
  // record does not is the caller's question — it is the caller that holds the
  // record, and it drops a disc whose name and record agree.
  assert.equal(discSubtitle('Show'), 'Show');
});

test('a year at the very end of a name is left unread', () => {
  // This was tried, and the measurement said it was free: over all 395 names in
  // the collection it claims a year for exactly one of them —
  // `Led Zeppelin - II USA 8-track 1969` — and moves nothing else.
  //
  // It is not free, because this parser is also what `recordTitle` runs over,
  // and `recordTitle` is handed the TITLE of a cue and of a tag as readily as a
  // folder name. `A State Of Trance: Ibiza 2026` is one of those and its
  // trailing `2026` is the record's name, not its year: the rule took a word
  // out of it, and `multidisc.test.ts` is the test that caught it.
  //
  // Nothing tells the two strings apart, and one record keeping an unknown year
  // is the cheaper mistake by a distance. So neither is read.
  assert.equal(parseFolderName('Led Zeppelin - II USA 8-track 1969').year, null);
  assert.equal(parseFolderName('A State Of Trance: Ibiza 2026').title, 'A State Of Trance: Ibiza 2026');

  // Two years are no better: `Tangerine Dream - Green Desert UK Cass 1973 1986`
  // is recorded in 1973 and released in 1986, and the name does not choose.
  assert.equal(parseFolderName('Tangerine Dream - Green Desert UK Cass 1973 1986').year, null);
});

test('the note a folder states is answered in the brackets it was written in', () => {
  // Two readers want the same note and want it said differently. `recordVersion`
  // answers what it *says*, with the pressing's own year taken off, because that
  // is what a record's name outside the tree uses — `Maschina Records, MKK881CD`
  // and not `2019, Maschina Records, MKK881CD`, since 2019 dates the pressing.
  // The tree is the folder view and answers how the folder wrote it, brackets
  // and all: `1990 - Entreat [1991 issue AU Warner 903174106-2]` is what the
  // folder says, and square brackets are how this collection writes a pressing
  // (task:2783).
  assert.equal(folderNote('1990 - Entreat [1991 issue AU Warner 903174106-2]'), '[1991 issue AU Warner 903174106-2]');
  assert.equal(folderNote('1994 - Cock E.S.P. + Thirdorgan - Split (Cass, C60)'), '(Cass, C60)');
  assert.equal(folderNote('1988 ● Группа крови (2019, Maschina Records, MKK881CD, 3CD)'), '(2019, Maschina Records, MKK881CD, 3CD)');

  // The same read, read two ways: the year the pressing carries is the note's
  // own and is not the record's.
  assert.equal(recordVersion('1988 ● Группа крови (2019, Maschina Records, MKK881CD, 3CD)'), 'Maschina Records, MKK881CD, 3CD');

  // A name that states no note has none to give, and the round kind is only a
  // note when it reads like one — `(Moenai Hai)` is part of a title.
  assert.equal(folderNote('2008 - Med Sud I Eyrum Vid Spilum Endalaust'), null);
  assert.equal(folderNote('The Gerogerigegege - 2016 - 燃えない灰 (Moenai Hai)'), null);
});

test('a note the name already says is not to be said again', () => {
  // The question every reader of a record's name has to ask the same way, and
  // the reason it is asked of the note's words rather than of the brackets the
  // folder wrote: `recordTitle` puts the note into a title in *round* brackets
  // with the pressing's own year off, so a folder stating `[EU Polydor 981
  // 463-0]` leaves a title saying `(EU Polydor 981 463-0)`. Asked of the square
  // form, the answer was "not said yet" for 34 records in the tree and 18 in the
  // album list — and both said it again (task:2845).
  assert.equal(
    unsaidNote('Join The Dots (EU Polydor 981 463-0)', '2004 - Join The Dots [EU Polydor 981 463-0]'),
    null,
  );
  // The pressing's year goes the way the title's did, so a note carrying one is
  // still the same note.
  assert.equal(
    unsaidNote(
      'Группа крови (Maschina Records, MKK881CD, 3CD)',
      '1988 ● Группа крови (2019, Maschina Records, MKK881CD, 3CD)',
    ),
    null,
  );
  // A title that says nothing is owed the note — as `recordVersion` answers it,
  // without the pressing's own year, because that is the form every name uses.
  assert.equal(
    unsaidNote('Entreat', '1990 - Entreat [1991 issue AU Warner 903174106-2]'),
    '1991 issue AU Warner 903174106-2',
  );
  // And a folder that says nothing has nothing to lend.
  assert.equal(unsaidNote('Von', '1997 - Von'), null);
});
