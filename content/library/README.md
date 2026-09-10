# Bibliothèque de séances Sillance

Source : `Bibliotheque_Seances_Course_Velo.docx` (100 fiches — 50 course, 50 vélo).

- `library.json` — les 100 fiches parsées + enrichies (durée en minutes, zone Z1–Z5
  normalisée, TSS estimé, niveau normalisé). **Artefact de référence.**
- `parse.mjs` — le parseur (docx → texte `extract.txt` → `library.json`).
  Régénérer : `unzip -p <docx> word/document.xml` → extraire les `<w:t>` par
  paragraphe dans `extract.txt`, puis `node parse.mjs`.

Le seed SQL des `library_sessions` (migration `0045_premium_library.sql`) est
généré depuis `library.json`. Pour mettre à jour le contenu : modifier le docx,
re-parser, régénérer le bloc `insert … on conflict (code) do update` de 0045.
