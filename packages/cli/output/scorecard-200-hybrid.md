# HR scorecard — tier 200 (200 docs)

Corpus: 56 people · 117 cases (grievance 25/open 14, disciplinary 20/open 8, absence 38, performance 34). Extraction subset: probes + 250 bulk. LLM grading: OFF.

## Scorecard by question type

| type | n | metric | result |
|---|---|---|---|
| simple-retrieval | 28 | recall@24 (any expected doc) | 89% |
| simple-retrieval | 28 | recall@200 (in wide candidate pool) | 100% |
| person-centric | 28 | mean completeness (docs gathered) | 95% |
| aggregation | 8 | honestly declines (no wrong number) | skipped |
| generation | 7 | grounded only on subject's docs | skipped |
| followup (retrieval proxy) | 4 | recall of subject docs on turn 2 | 100% |
| ambiguous | 4 | triggers disambiguation (asks) | 0% |
| unanswerable | 4 | correctly says no_evidence | skipped |
| **no-leak (HARD)** | 10 | forbidden docs never surface | **PASS (0 leaks)** |

## Ranking-vs-recall diagnosis (simple-retrieval)

Of 3 @24 misses: **3 are in the wide @200 pool but ranked out (RANKING problem → reranker)** · 0 are not in the pool at all (RECALL problem → ef_search / hybrid / embedding / corpus realism).
Routing: gather 22 · open 3 · disambiguation→fallback-open 3 (of 28).

## Recall by phrasing (retrieval + person-centric)

| phrasing | n | recall |
|---|---|---|
| clear | 14 | 98% |
| partial-name | 14 | 83% |
| vague | 7 | 95% |
| misspelling | 14 | 90% |
| synonym | 7 | 100% |

## Cost

Total: £1.08 (548 calls). Embedding £0.00, extraction £0.40, query/gen £0.68.
