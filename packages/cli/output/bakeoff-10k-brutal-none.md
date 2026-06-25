# HR scorecard — tier 10000 (10001 docs)

Corpus: **brutal** · Reranker: **none** · rerank 0 calls, mean **0ms/call**

Corpus: 2819 people · 5613 cases (grievance 1435/open 710, disciplinary 1361/open 425, absence 1402, performance 1415). Extraction subset: probes + 250 bulk. LLM grading: OFF.

## Scorecard by question type

| type | n | metric | result |
|---|---|---|---|
| simple-retrieval | 28 | recall@24 (any expected doc) | 36% |
| simple-retrieval | 28 | recall@200 (in wide candidate pool) | 89% |
| person-centric | 28 | mean completeness (docs gathered) | 100% |
| aggregation | 8 | honestly declines (no wrong number) | skipped |
| generation | 7 | grounded only on subject's docs | skipped |
| followup (retrieval proxy) | 4 | recall of subject docs on turn 2 | 75% |
| ambiguous | 4 | triggers disambiguation (asks) | 25% |
| unanswerable | 4 | correctly says no_evidence | skipped |
| **no-leak (HARD)** | 10 | forbidden docs never surface | **PASS (0 leaks)** |

## Ranking-vs-recall diagnosis (simple-retrieval)

Of 18 @24 misses: **15 are in the wide @200 pool but ranked out (RANKING problem → reranker)** · 3 are not in the pool at all (RECALL problem → ef_search / hybrid / embedding / corpus realism).
Routing: gather 17 · open 3 · disambiguation→fallback-open 8 (of 28).

## Recall by phrasing (retrieval + person-centric)

| phrasing | n | recall |
|---|---|---|
| clear | 14 | 71% |
| partial-name | 14 | 64% |
| vague | 7 | 100% |
| misspelling | 14 | 71% |
| synonym | 7 | 29% |

## Cost

Total: £0.76 (10657 calls). Embedding £0.16, extraction £0.60, query/gen £0.00.
