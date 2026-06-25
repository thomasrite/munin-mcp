# Parser test fixtures (F11)

Tiny, real binary documents that exercise the PDF (`unpdf`) and DOCX (`mammoth`)
read paths on actual files — the gap tracked as F11 (the demo corpus was
text-only `.md`/`.txt`). Used by `../parsers.test.ts`.

| File | What it exercises |
| --- | --- |
| `text.pdf` | A 2-page text PDF — page-structured extraction + the **buffer-detach regression** (pdf.js detaches the buffer it parses; the parser must parse a copy so the pipeline can still upload the original bytes to blob storage). |
| `scanned.pdf` | A 1-page PDF with **no text operators** (a vector fill) — the "scanned / image-only → no extractable text" path. |
| `sample.docx` | A minimal real DOCX (heading + 2 paragraphs) — paragraph extraction + heading-path structure via mammoth. Also doubles as "non-PDF bytes" for the misnamed-`.docx.pdf` error path. |

These are committed (they're <2 KB each). They were generated deterministically
with the Python standard library (no new dependency) — `zipfile` builds the DOCX;
the PDFs are hand-assembled with a correct cross-reference table. To regenerate,
see the generator snippet in the F11 closure commit, or recreate equivalents
with any tool — the tests assert content, not bytes.
