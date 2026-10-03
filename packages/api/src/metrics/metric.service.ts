import { Inject, Injectable } from "@nestjs/common";
import type { AppConfig } from "../config/app-config.js";
import { getDemoMetrics } from "../demo/demo-fixtures.js";
import type { MetricSample } from "../metrics/metrics.models.js";
import { withHistory } from "./metric-history.js";
import type { MetricRepository } from "../persistence/repositories/metric.repository.js";
import type { PaginationParams } from "../common/pagination.js";
import { APP_CONFIG, METRIC_REPOSITORY } from "../tokens.js";
import {
  HOST_FRESHNESS_THRESHOLD_MS,
  isFreshTimestamp as isFreshTimestampShared,
} from "../common/host-health.js";

const STALE_THRESHOLD_MS = HOST_FRESHNESS_THRESHOLD_MS;

function withFreshness<T extends MetricSample>(
  sample: T,
): T & { freshness: "fresh" | "stale" } {
  const timestamp = sample.receivedAt ?? sample.collectedAt;
  return {
    ...sample,
    freshness: isFreshTimestampShared(timestamp, STALE_THRESHOLD_MS)
      ? "fresh"
      : "stale",
  };
}

/**
 * Sort metrics newest-first by effective_at (collectedAt/receivedAt desc), then vps_id desc.
 */
function sortLatestDesc(samples: MetricSample[]): MetricSample[] {
  return [...samples].sort((a, b) => {
    const aTime = new Date(a.receivedAt ?? a.collectedAt).getTime();
    const bTime = new Date(b.receivedAt ?? b.collectedAt).getTime();
    if (bTime !== aTime) return bTime - aTime;
    return b.vpsId.localeCompare(a.vpsId);
  });
}

@Injectable()
export class MetricService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRIC_REPOSITORY)
    private readonly metricRepository: MetricRepository,
  ) {}

  async list(vpsId?: string, page?: PaginationParams): Promise<MetricSample[]> {
    if (this.config.mode === "demo") {
      let results = getDemoMetrics() as MetricSample[];
      if (vpsId) {
        return results.filter((m) => m.vpsId === vpsId);
      }
      results = sortLatestDesc(results);
      if (page) {
        return results.slice(page.offset, page.offset + page.limit);
      }
      return results;
    }

    if (vpsId) {
      const result = await this.metricRepository.getLatest(vpsId);
      if (!result) return [];
      const window = await this.metricRepository.listWindow(
        vpsId,
        this.config.metricWindowLimit,
      );
      return [withFreshness(withHistory(result, window, this.config.metricWindowLimit))];
    }

    const latest = await this.metricRepository.listLatest(page);
    const metricList = await Promise.all(
      latest.map(async (sample) => {
        const window = await this.metricRepository.listWindow(
          sample.vpsId,
          this.config.metricWindowLimit,
        );
        return withHistory(sample, window, this.config.metricWindowLimit);
      }),
    );
    return metricList.map(withFreshness);
  }

  async append(sample: MetricSample): Promise<MetricSample> {
    return this.metricRepository.append(sample, this.config.metricWindowLimit);
  }

  async listLatest(vpsId?: string): Promise<MetricSample[]> {
    const results = await this.metricRepository.listLatest();
    if (vpsId) {
      return results.filter((m) => m.vpsId === vpsId);
    }
    return results;
  }

  async getLatest(vpsId: string): Promise<MetricSample | undefined> {
    return this.metricRepository.getLatest(vpsId);
  }

  async upsertLatest(sample: MetricSample): Promise<MetricSample> {
    return this.metricRepository.upsertLatest(sample);
  }

  async appendWindow(sample: MetricSample, limit?: number): Promise<void> {
    return this.metricRepository.appendWindow(sample, limit);
  }

  async listWindow(vpsId: string, limit?: number): Promise<MetricSample[]> {
    return this.metricRepository.listWindow(vpsId, limit);
  }
}
