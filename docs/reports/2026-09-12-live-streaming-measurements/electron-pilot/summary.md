# Focused Electron streaming summary

Status: **incomplete-pilot-matrix** (12/72 samples).

Instrumented focused Electron delivery pipeline; excludes engine/supervisor/host workers, production recovery/health timers, and operational logging outside delivery tracing.

Combined Electron CPU sums Browser and Tab cumulative CPU deltas only; mainCpuMicros is validated but never added.

Arrival-to-commit percentiles depend on cross-process monotonic-clock calibration. The conservative per-sample bound adds half the endpoint offset drift to the larger endpoint uncertainty; paired bounds sum candidate and baseline bounds.

## Per workload and policy

| Workload | Policy | n | CPU µs median [range] | Sends median [range] | Commits median [range] | p95 ms median [range] | p99 ms median [range] | Conservative clock uncertainty ms median [range] | Raw reported uncertainty ms median [range] |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| paced-4 | original | 3 | 1865410 [1852747–2018035] | 812 [812–812] | 803 [802–804] | 4.472 [4.289–4.56] | 5.248 [5.232–5.355] | 0.057 [0.038–0.066] | 0.031 [0.025–0.036] |
| paced-4 | 0 | 3 | 1794259 [1782766–2081816] | 812 [812–812] | 804 [803–805] | 4.45 [4.436–4.511] | 5.177 [5.089–5.195] | 0.049 [0.035–0.061] | 0.031 [0.027–0.036] |
| paced-4 | 8 | 3 | 1595219 [1561200–1610478] | 412 [412–413] | 404 [403–404] | 11.989 [11.888–12.179] | 13.288 [12.886–13.342] | 0.055 [0.042–0.073] | 0.031 [0.03–0.038] |
| paced-4 | 16 | 3 | 1494599 [1483397–1558025] | 232 [231–234] | 222 [221–224] | 20.199 [20.119–20.253] | 21.148 [21.116–21.216] | 0.048 [0.044–0.065] | 0.028 [0.025–0.033] |

## Paired comparisons

| Rep | Workload | Policy | Baseline | CPU reduction % | Added p95 ms | p95 gate | Added p99 ms | p99 gate | Pair uncertainty ±ms |
|---:|---|---:|---:|---:|---:|---|---:|---|---:|
| 0 | paced-4 | 16 | original | 26.493 | 15.831 | pass | 15.916 | pass | 0.122 |
| 0 | paced-4 | 16 | 0 | 28.745 | 15.608 | pass | 15.953 | pass | 0.1 |
| 0 | paced-4 | 8 | original | 20.952 | 7.7 | pass | 7.654 | pass | 0.099 |
| 0 | paced-4 | 8 | 0 | 23.374 | 7.478 | pass | 7.691 | pass | 0.077 |
| 1 | paced-4 | 16 | original | 19.331 | 15.727 | pass | 15.869 | pass | 0.083 |
| 1 | paced-4 | 16 | 0 | 16.701 | 15.763 | pass | 16.028 | pass | 0.105 |
| 1 | paced-4 | 8 | original | 15.736 | 7.415 | pass | 8.094 | pass | 0.112 |
| 1 | paced-4 | 8 | 0 | 12.989 | 7.452 | pass | 8.253 | pass | 0.134 |
| 2 | paced-4 | 16 | original | 16.478 | 15.693 | pass | 15.861 | pass | 0.114 |
| 2 | paced-4 | 16 | 0 | 12.606 | 15.802 | pass | 16.039 | pass | 0.096 |
| 2 | paced-4 | 8 | original | 13.666 | 7.619 | pass | 7.933 | pass | 0.121 |
| 2 | paced-4 | 8 | 0 | 9.664 | 7.729 | pass | 8.112 | pass | 0.104 |

Missing: 0/sparse-1/original, 0/sparse-1/0, 0/sparse-1/8, 0/sparse-1/16, 0/paced-8/original, 0/paced-8/0, 0/paced-8/8, 0/paced-8/16, 0/long-history-8/original, 0/long-history-8/0, 0/long-history-8/8, 0/long-history-8/16, 0/burst-4/original, 0/burst-4/0, 0/burst-4/8, 0/burst-4/16, 0/barriers-4/original, 0/barriers-4/0, 0/barriers-4/8, 0/barriers-4/16, 1/sparse-1/original, 1/sparse-1/0, 1/sparse-1/8, 1/sparse-1/16, 1/paced-8/original, 1/paced-8/0, 1/paced-8/8, 1/paced-8/16, 1/long-history-8/original, 1/long-history-8/0, 1/long-history-8/8, 1/long-history-8/16, 1/burst-4/original, 1/burst-4/0, 1/burst-4/8, 1/burst-4/16, 1/barriers-4/original, 1/barriers-4/0, 1/barriers-4/8, 1/barriers-4/16, 2/sparse-1/original, 2/sparse-1/0, 2/sparse-1/8, 2/sparse-1/16, 2/paced-8/original, 2/paced-8/0, 2/paced-8/8, 2/paced-8/16, 2/long-history-8/original, 2/long-history-8/0, 2/long-history-8/8, 2/long-history-8/16, 2/burst-4/original, 2/burst-4/0, 2/burst-4/8, 2/burst-4/16, 2/barriers-4/original, 2/barriers-4/0, 2/barriers-4/8, 2/barriers-4/16
