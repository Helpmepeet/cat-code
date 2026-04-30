/**
 * BigQuery metrics exporter is intentionally disabled.
 *
 * This file preserves the exported class interface (PushMetricExporter) so
 * that any transitive imports don't break at runtime. No data is sent.
 */

import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import {
  AggregationTemporality,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'

export class BigQueryMetricsExporter implements PushMetricExporter {
  export(
    _metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    resultCallback({ code: ExportResultCode.SUCCESS })
    return Promise.resolve()
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA
  }
}
