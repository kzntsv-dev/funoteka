-- The cue's own metadata, which was parsed and then dropped on the floor.
--
-- wiki:3499 §8: "CATALOG in cue is the source of the catalogue number, with
-- priority over the folder name". The parser has always filled `doc.rem`, but
-- nothing read it and there was nowhere to put it, so every album got the raw
-- folder name — `[2026-08-28] VA - A State Of Trance_Ibiza 2026 (...)[ARDI4701]`
-- when the cue plainly says `TITLE "A State Of Trance: Ibiza 2026"`.

ALTER TABLE cue ADD COLUMN catalog TEXT;

-- The whole REM block, so a later stage can reach DATE / GENRE / DISCID /
-- COMMENT without another migration. JSON, because REM keys are open-ended —
-- real rips carry whatever the ripper felt like.
ALTER TABLE cue ADD COLUMN rem_json TEXT;
