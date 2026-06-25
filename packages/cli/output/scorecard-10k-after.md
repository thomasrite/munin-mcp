# HR scorecard — tier 10000 (10001 docs)

Corpus: 2819 people · 5613 cases (grievance 1435/open 710, disciplinary 1361/open 425, absence 1402, performance 1415). Extraction subset: probes + 250 bulk. LLM grading: OFF.

## Scorecard by question type

| type | n | metric | result |
|---|---|---|---|
| simple-retrieval | 28 | recall@24 (any expected doc) | 39% |
| simple-retrieval | 28 | recall@200 (in wide candidate pool) | 89% |
| person-centric | 28 | mean completeness (docs gathered) | 95% |
| aggregation | 8 | honestly declines (no wrong number) | skipped |
| generation | 7 | grounded only on subject's docs | skipped |
| followup (retrieval proxy) | 4 | recall of subject docs on turn 2 | 50% |
| ambiguous | 4 | triggers disambiguation (asks) | 25% |
| unanswerable | 4 | correctly says no_evidence | skipped |
| **no-leak (HARD)** | 10 | forbidden docs never surface | **PASS (0 leaks)** |

## Ranking-vs-recall diagnosis (simple-retrieval)

Of 17 @24 misses: **14 are in the wide @200 pool but ranked out (RANKING problem → reranker)** · 3 are not in the pool at all (RECALL problem → ef_search / hybrid / embedding / corpus realism).
Routing: gather 17 · open 3 · disambiguation→fallback-open 8 (of 28).

## Recall by phrasing (retrieval + person-centric)

| phrasing | n | recall |
|---|---|---|
| clear | 14 | 69% |
| partial-name | 14 | 62% |
| vague | 7 | 95% |
| misspelling | 14 | 69% |
| synonym | 7 | 43% |

## Cost

Total: £1.62 (10904 calls). Embedding £0.17, extraction £0.60, query/gen £0.85.
