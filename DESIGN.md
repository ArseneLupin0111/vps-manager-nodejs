# FlexServer Dashboard Design System

The dashboard follows `VPS Management Dashboard/src`: a compact dark operational console with lime command accents and square panels.

## Tokens

`packages/web/src/index.css` defines three token layers: `--palette-*` primitive HSL channels, semantic surface/status aliases, and `--fleet-*` / `--telemetry-*` component aliases. Tailwind exposes `ink`, `panel`, `raised`, `line`, `dim`, `text`, `signal`, `warn`, `crit`, and `info`; shadcn semantic tokens map to this palette. Use tokens rather than component-local color literals.

- `ink`: page background and inputs; `panel`: cards and dialogs.
- `raised`: secondary and hover surfaces; `line`: borders and separators.
- `text`: primary text; `dim`: secondary text.
- `signal`: lime commands, healthy states, active tabs.
- `warn`, `crit`, `info`: amber warning, red failure, blue information.

## Layout and typography

- Fleet sidebar: 272px desktop host navigation, active host indicator, health count, CPU/RAM snapshots, and create action. Below `lg`, hosts become a horizontally scrollable rail.
- Fleet page: operational summaries, search/status filters, card/table switch, two-column cards collapsing to one on narrow screens. Search filters the page results, not the persistent host navigation.
- Workspace: server identity and seven horizontal section links; compact host/container/job summaries, failure notice, three resource gauges, two telemetry panels, recent audit and jobs, then static system facts.
- Flat square surfaces, no decorative gradients or panel shadows.
- Body text is compact; `.tnum` provides monospace tabular numerals for telemetry and identifiers.
- Progress bars are thin. Status pills retain text labels, not color alone.
- Secondary text uses the shared `dim` token at 68% lightness. Capacity labels use explicit binary units (KiB/MiB/GiB/TiB), consistent across host and Docker byte counts.
- Overview audit rows prioritize time/actor and event/outcome; redundant server and opaque identifiers stay in the details drawer. Compact job panels size to content rather than stretching to match audit height.

## Data and interaction

Retain existing API-backed actions, dialogs, authentication, capability restrictions, and terminal lifecycle. Missing telemetry must be labeled unavailable; charts must not relabel CPU history as memory or network history. Docker monitoring remains a separate workspace tab.

Keep keyboard focus visible and dialogs dismissible. Tables may scroll within their containers on narrow screens. Pulse indicators respect reduced motion; existing overlay transitions remain in the shared primitives.

- Host health is independent of job outcomes and container counts. Recent failed jobs produce a notice linking to Jobs; non-running containers have a neutral count and Docker link, not an inferred failure. Stale Docker counts retain an explicit snapshot label.
- Failed jobs display the percentage reached, reported failure reason and finish time when available. Progress bars appear only while jobs are running; absent worker/duration metadata is omitted. Existing log links remain available.

### Public landing and access

The landing at `/` reuses the charcoal/lime tokens but uses 16–17px reading text, 64–96px desktop section spacing and 40–56px mobile spacing. Keep the two-line hero and a static, labeled preview with server rows, resource readings, one chart and one task area. On mobile, content and CTAs precede the full-width preview; do not scale a desktop console down.

Use five benefit groups, a short startup workflow, explicit demo/local explanation, native keyboard-operable FAQ disclosures, then deployment actions. `/vps` is the existing mode-aware authentication boundary, not a public-demo promise. Vietnamese access states must retain session authentication, non-sensitive errors and a home link. Preserve visible focus, a focusable skip target, sticky-header anchor clearance and reduced-motion support.

## Reusable components

- `components/layout/FleetSidebar.tsx`: fleet navigation from VPS records and metric snapshots; `FleetHostItem.tsx`: route-aware selectable host row.
- `components/dashboard/shared/ResourceGauge.tsx`: labelled percentage, capacity/detail, segmented meter, unavailable state, and warning/critical thresholds.
- `components/dashboard/shared/SystemFacts.tsx`: responsive labelled facts strip from `{ label, value }` pairs.
- `components/dashboard/metrics/MetricsPanel.tsx` exports `ChartPanel`: shared telemetry history panel used by metrics and overview, with series legends, current readouts, and missing-history states.

Overview histories must match the selected VPS: CPU and memory render two percent series from that host's own `history` window, and network I/O renders separate RX/TX bytes-per-second series on a shared axis. RX/TX rows carry an explicit `networkUnit: "bytes/s"` stamp with `networkAvailable: false` on first/reset samples (projected to gaps, never zero); absent unit means unknown and renders `n/a` — never a guessed unit. Null gaps break chart lines without interpolation or zero-fill, and empty windows render `History unavailable` vs `Not enough history yet`. No fabricated network lines, no percent network threshold, and no relabelled CPU history.

