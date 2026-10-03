-- Host network unit/availability for metric rows.
--
-- network_unit is "bytes/s" when the collector emitted a rate. Absent on
-- old rows = unknown, never a guessed unit. Legacy source="agent" rows
-- without a unit are rate-proven (Go collectNetwork always emits
-- rxDelta/elapsed) and are stamped to "bytes/s" at read time; legacy
-- source="local-agent" rows without a unit stay absent (cumulative
-- unknown, projected to null).
-- network_available=false marks first-sample / reset / elapsed<=0 /
-- unreadable. Collectors emit rx=tx=0 on the wire to satisfy the numeric
-- schema, but the projector maps false to null, never 0.

ALTER TABLE metric_samples
  ADD COLUMN IF NOT EXISTS network_unit text;
ALTER TABLE metric_samples
  ADD COLUMN IF NOT EXISTS network_available boolean;

ALTER TABLE metric_latest
  ADD COLUMN IF NOT EXISTS network_unit text;
ALTER TABLE metric_latest
  ADD COLUMN IF NOT EXISTS network_available boolean;
