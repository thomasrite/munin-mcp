# HR scorecard — tier 10000 (10000 docs)

Corpus: 2817 people · 5604 cases (grievance 1363/open 701, disciplinary 1398/open 433, absence 1464, performance 1379). Extraction subset: probes + 0 bulk. LLM grading: OFF.

## Scorecard by question type

| type | n | metric | result |
|---|---|---|---|
| simple-retrieval | 28 | recall@24 (any expected doc) | 57% |
| simple-retrieval | 28 | recall@200 (in wide candidate pool) | 93% |
| person-centric | 28 | mean completeness (docs gathered) | 78% |
| aggregation | 8 | within ±tol of true count | skipped |
| generation | 7 | grounded only on subject's docs | skipped |
| followup (retrieval proxy) | 4 | recall of subject docs on turn 2 | 75% |
| ambiguous | 4 | triggers disambiguation (asks) | 75% |
| unanswerable | 4 | correctly says no_evidence | skipped |
| **no-leak (HARD)** | 10 | forbidden docs never surface | **PASS (0 leaks)** |

## Ranking-vs-recall diagnosis (simple-retrieval)

Of 12 @24 misses: **10 are in the wide @200 pool but ranked out (RANKING problem → reranker)** · 2 are not in the pool at all (RECALL problem → ef_search / hybrid / embedding / corpus realism).

## Recall by phrasing (retrieval + person-centric)

| phrasing | n | recall |
|---|---|---|
| clear | 14 | 68% |
| partial-name | 14 | 60% |
| vague | 7 | 78% |
| misspelling | 14 | 75% |
| synonym | 7 | 57% |

## Cost

Total: £0.20 (10164 calls). Embedding £0.09, extraction £0.11, query/gen £0.00.
