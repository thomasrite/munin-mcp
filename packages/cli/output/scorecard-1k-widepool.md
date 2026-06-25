# HR scorecard — tier 1000 (1000 docs)

Corpus: 273 people · 563 cases (grievance 135/open 72, disciplinary 125/open 35, absence 156, performance 147). Extraction subset: probes + 250 bulk. LLM grading: OFF.

## Scorecard by question type

| type | n | metric | result |
|---|---|---|---|
| simple-retrieval | 28 | recall@24 (any expected doc) | 75% |
| simple-retrieval | 28 | recall@200 (in wide candidate pool) | 100% |
| person-centric | 28 | mean completeness (docs gathered) | 88% |
| aggregation | 8 | honestly declines (no wrong number) | skipped |
| generation | 7 | grounded only on subject's docs | skipped |
| followup (retrieval proxy) | 4 | recall of subject docs on turn 2 | 75% |
| ambiguous | 4 | triggers disambiguation (asks) | 25% |
| unanswerable | 4 | correctly says no_evidence | skipped |
| **no-leak (HARD)** | 10 | forbidden docs never surface | **PASS (0 leaks)** |

## Ranking-vs-recall diagnosis (simple-retrieval)

Of 7 @24 misses: **7 are in the wide @200 pool but ranked out (RANKING problem → reranker)** · 0 are not in the pool at all (RECALL problem → ef_search / hybrid / embedding / corpus realism).
Routing: gather 16 · open 3 · disambiguation→fallback-open 9 (of 28).

## Recall by phrasing (retrieval + person-centric)

| phrasing | n | recall |
|---|---|---|
| clear | 14 | 87% |
| partial-name | 14 | 80% |
| vague | 7 | 88% |
| misspelling | 14 | 73% |
| synonym | 7 | 86% |

## Cost

Total: £2.09 (1453 calls). Embedding £0.02, extraction £0.60, query/gen £1.48.
