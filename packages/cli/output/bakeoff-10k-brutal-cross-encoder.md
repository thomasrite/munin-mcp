# HR scorecard — tier 10000 (10001 docs)

Corpus: **brutal** · Reranker: **cross-encoder (BAAI/bge-reranker-v2-m3)** · rerank 45 calls, mean **20063ms/call**

Corpus: 2819 people · 5613 cases (grievance 1435/open 710, disciplinary 1361/open 425, absence 1402, performance 1415). Extraction subset: probes + 250 bulk. LLM grading: OFF.

## Scorecard by question type

| type | n | metric | result |
|---|---|---|---|
| simple-retrieval | 28 | recall@24 (any expected doc) | 54% |
| simple-retrieval | 28 | recall@200 (in wide candidate pool) | 89% |
| person-centric | 28 | mean completeness (docs gathered) | 100% |
| aggregation | 8 | honestly declines (no wrong number) | skipped |
| generation | 7 | grounded only on subject's docs | skipped |
| followup (retrieval proxy) | 4 | recall of subject docs on turn 2 | 25% |
| ambiguous | 4 | triggers disambiguation (asks) | 25% |
| unanswerable | 4 | correctly says no_evidence | skipped |
| **no-leak (HARD)** | 10 | forbidden docs never surface | **PASS (0 leaks)** |

## Ranking-vs-recall diagnosis (simple-retrieval)

Of 13 @24 misses: **10 are in the wide @200 pool but ranked out (RANKING problem → reranker)** · 3 are not in the pool at all (RECALL problem → ef_search / hybrid / embedding / corpus realism).
Routing: gather 17 · open 3 · disambiguation→fallback-open 8 (of 28).

## Recall by phrasing (retrieval + person-centric)

| phrasing | n | recall |
|---|---|---|
| clear | 14 | 86% |
| partial-name | 14 | 57% |
| vague | 7 | 100% |
| misspelling | 14 | 79% |
| synonym | 7 | 71% |

## Cost

Total: £0.75 (10749 calls). Embedding £0.17, extraction £0.59, query/gen £0.00.
