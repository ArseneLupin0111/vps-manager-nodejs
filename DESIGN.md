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
- Workspace: server identity and all seven horizontal section links; three segmented resource gauges, two telemetry panels, system facts, audit and jobs.
- Flat square surfaces, no decorative gradients or panel shadows.
- Body text is compact; `.tnum` provides monospace tabular numerals for telemetry and identifiers.
- Progress bars are thin. Status pills retain text labels, not color alone.

## Data and interaction

Retain existing API-backed actions, dialogs, authentication, capability restrictions, and terminal lifecycle. Missing telemetry must be labeled unavailable; charts must not relabel CPU history as memory or network history. Docker monitoring remains a separate workspace tab.

Keep keyboard focus visible and dialogs dismissible. Tables may scroll within their containers on narrow screens. Pulse indicators respect reduced motion; existing overlay transitions remain in the shared primitives.

## Reusable components

- `components/layout/FleetSidebar.tsx`: fleet navigation from VPS records and metric snapshots; `FleetHostItem.tsx`: route-aware selectable host row.
- `components/dashboard/shared/ResourceGauge.tsx`: labelled percentage, capacity/detail, segmented meter, unavailable state, and warning/critical thresholds.
- `components/dashboard/shared/SystemFacts.tsx`: responsive labelled facts strip from `{ label, value }` pairs.
- `components/dashboard/metrics/MetricsPanel.tsx` exports `ChartPanel`: shared telemetry history panel used by metrics and overview, with series legends, current readouts, and missing-history states.

Overview histories must match the selected VPS and declared trend unit. RX/TX snapshots are cumulative byte counters, not Mb/s throughput; no fabricated network lines or relabelled CPU history.

