# HR scorecard — tier 1000 (1000 docs)

Corpus: 273 people · 563 cases (grievance 135/open 72, disciplinary 125/open 35, absence 156, performance 147). Extraction subset: probes + 250 bulk. LLM grading: ON.

## Scorecard by question type

| type | n | metric | result |
|---|---|---|---|
| simple-retrieval | 28 | recall@24 (any expected doc) | 75% |
| simple-retrieval | 28 | recall@200 (in wide candidate pool) | 100% |
| person-centric | 28 | mean completeness (docs gathered) | 95% |
| aggregation | 8 | honestly declines (no wrong number) | 100% |
| generation | 7 | grounded only on subject's docs | 71% |
| followup (retrieval proxy) | 4 | recall of subject docs on turn 2 | 75% |
| ambiguous | 4 | triggers disambiguation (asks) | 0% |
| unanswerable | 4 | correctly says no_evidence | 100% |
| **no-leak (HARD)** | 10 | forbidden docs never surface | **PASS (0 leaks)** |

## Ranking-vs-recall diagnosis (simple-retrieval)

Of 7 @24 misses: **7 are in the wide @200 pool but ranked out (RANKING problem → reranker)** · 0 are not in the pool at all (RECALL problem → ef_search / hybrid / embedding / corpus realism).
Routing: gather 17 · open 3 · disambiguation→fallback-open 8 (of 28).

## Recall by phrasing (retrieval + person-centric)

| phrasing | n | recall |
|---|---|---|
| clear | 14 | 90% |
| partial-name | 14 | 76% |
| vague | 7 | 95% |
| misspelling | 14 | 83% |
| synonym | 7 | 86% |

Generation grounding: 104 grounded claims, 14 dropped (ungrounded, fail-closed) across 7 drafts.

## Aggregation detail (true count vs system response)

| question | true | system response | honest |
|---|---|---|---|
| How many grievance cases are recorded across the trust? | 135 | declined to count | yes |
| How many open grievances are there? | 72 | declined to count | yes |
| How many disciplinary cases are on file? | 125 | declined to count | yes |
| How many open disciplinary cases are there? | 35 | declined to count | yes |
| How many sickness-absence cases are recorded? | 156 | declined to count | yes |
| How many performance/capability cases are there? | 147 | declined to count | yes |
| How many HR cases are recorded in total across the trust? | 563 | declined to count | yes |
| how many staff have an open case of any kind | 221 | declined to count | yes |

## Cost

Total: £1.55 (1479 calls). Embedding £0.02, extraction £0.60, query/gen £0.93.
