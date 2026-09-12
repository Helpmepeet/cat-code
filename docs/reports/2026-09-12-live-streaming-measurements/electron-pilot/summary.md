# Focused Electron streaming summary

Status: **incomplete-pilot-matrix** (12/72 samples).

Instrumented focused Electron delivery pipeline; excludes engine/supervisor/host workers, production recovery/health timers, and operational logging outside delivery tracing.

Combined Electron CPU sums Browser and Tab cumulative CPU deltas only; mainCpuMicros is validated but never added.

Arrival-to-commit percentiles depend on cross-process monotonic-clock calibration; uncertainty is reported per sample and is not subtracted.

## Per workload and policy

| Workload | Policy | n | CPU µs median [range] | Sends median [range] | Commits median [range] | p95 ms median [range] | p99 ms median [range] | Clock uncertainty ms median [range] |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| paced-4 | original | 3 | 1865410 [1852747–2018035] | 812 [812–812] | 803 [802–804] | 4.472 [4.289–4.56] | 5.248 [5.232–5.355] | 0.031 [0.025–0.036] |
| paced-4 | 0 | 3 | 1794259 [1782766–2081816] | 812 [812–812] | 804 [803–805] | 4.45 [4.436–4.511] | 5.177 [5.089–5.195] | 0.031 [0.027–0.036] |
| paced-4 | 8 | 3 | 1595219 [1561200–1610478] | 412 [412–413] | 404 [403–404] | 11.989 [11.888–12.179] | 13.288 [12.886–13.342] | 0.031 [0.03–0.038] |
| paced-4 | 16 | 3 | 1494599 [1483397–1558025] | 232 [231–234] | 222 [221–224] | 20.199 [20.119–20.253] | 21.148 [21.116–21.216] | 0.028 [0.025–0.033] |

## Paired comparisons

| Rep | Workload | Policy | Baseline | CPU reduction % | Added p95 ms | Added p99 ms |
|---:|---|---:|---:|---:|---:|---:|
| 0 | paced-4 | 16 | original | 26.493 | 15.831 | 15.916 |
| 0 | paced-4 | 16 | 0 | 28.745 | 15.608 | 15.953 |
| 0 | paced-4 | 8 | original | 20.952 | 7.7 | 7.654 |
| 0 | paced-4 | 8 | 0 | 23.374 | 7.478 | 7.691 |
| 1 | paced-4 | 16 | original | 19.331 | 15.727 | 15.869 |
| 1 | paced-4 | 16 | 0 | 16.701 | 15.763 | 16.028 |
| 1 | paced-4 | 8 | original | 15.736 | 7.415 | 8.094 |
| 1 | paced-4 | 8 | 0 | 12.989 | 7.452 | 8.253 |
| 2 | paced-4 | 16 | original | 16.478 | 15.693 | 15.861 |
| 2 | paced-4 | 16 | 0 | 12.606 | 15.802 | 16.039 |
| 2 | paced-4 | 8 | original | 13.666 | 7.619 | 7.933 |
| 2 | paced-4 | 8 | 0 | 9.664 | 7.729 | 8.112 |

Missing: 0/sparse-1/original, 0/sparse-1/0, 0/sparse-1/8, 0/sparse-1/16, 0/paced-8/original, 0/paced-8/0, 0/paced-8/8, 0/paced-8/16, 0/long-history-8/original, 0/long-history-8/0, 0/long-history-8/8, 0/long-history-8/16, 0/burst-4/original, 0/burst-4/0, 0/burst-4/8, 0/burst-4/16, 0/barriers-4/original, 0/barriers-4/0, 0/barriers-4/8, 0/barriers-4/16, 1/sparse-1/original, 1/sparse-1/0, 1/sparse-1/8, 1/sparse-1/16, 1/paced-8/original, 1/paced-8/0, 1/paced-8/8, 1/paced-8/16, 1/long-history-8/original, 1/long-history-8/0, 1/long-history-8/8, 1/long-history-8/16, 1/burst-4/original, 1/burst-4/0, 1/burst-4/8, 1/burst-4/16, 1/barriers-4/original, 1/barriers-4/0, 1/barriers-4/8, 1/barriers-4/16, 2/sparse-1/original, 2/sparse-1/0, 2/sparse-1/8, 2/sparse-1/16, 2/paced-8/original, 2/paced-8/0, 2/paced-8/8, 2/paced-8/16, 2/long-history-8/original, 2/long-history-8/0, 2/long-history-8/8, 2/long-history-8/16, 2/burst-4/original, 2/burst-4/0, 2/burst-4/8, 2/burst-4/16, 2/barriers-4/original, 2/barriers-4/0, 2/barriers-4/8, 2/barriers-4/16
