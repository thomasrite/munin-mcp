# HR scorecard — tier 1000 (1000 docs)

Corpus: **realistic** · Reranker: **llm-judge (claude-sonnet-4-6)** · rerank 44 calls, mean **1434ms/call**

Corpus: 281 people · 558 cases (grievance 142/open 64, disciplinary 140/open 45, absence 138, performance 138). Extraction subset: probes + 250 bulk. LLM grading: OFF.

## Scorecard by question type

| type | n | metric | result |
|---|---|---|---|
| simple-retrieval | 28 | recall@24 (any expected doc) | 82% |
| simple-retrieval | 28 | recall@200 (in wide candidate pool) | 100% |
| person-centric | 28 | mean completeness (docs gathered) | 95% |
| aggregation | 8 | honestly declines (no wrong number) | skipped |
| generation | 7 | grounded only on subject's docs | skipped |
| followup (retrieval proxy) | 4 | recall of subject docs on turn 2 | 75% |
| ambiguous | 4 | triggers disambiguation (asks) | 50% |
| unanswerable | 4 | correctly says no_evidence | skipped |
| **no-leak (HARD)** | 10 | forbidden docs never surface | **PASS (0 leaks)** |

## Ranking-vs-recall diagnosis (simple-retrieval)

Of 5 @24 misses: **5 are in the wide @200 pool but ranked out (RANKING problem → reranker)** · 0 are not in the pool at all (RECALL problem → ef_search / hybrid / embedding / corpus realism).
Routing: gather 13 · open 12 · disambiguation→fallback-open 3 (of 28).

## Recall by phrasing (retrieval + person-centric)

| phrasing | n | recall |
|---|---|---|
| clear | 14 | 98% |
| partial-name | 14 | 83% |
| vague | 7 | 95% |
| misspelling | 14 | 76% |
| synonym | 7 | 100% |

## Cost

Total: £1.77 (1465 calls). Embedding £0.02, extraction £0.63, query/gen £1.12.
