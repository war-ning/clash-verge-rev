# Traffic statistics: interaction and implementation contract

Date: 2026-10-19. Scope approved in the rewrite handoff and
[refactor plan](traffic-stats-refactor-plan.md). This document makes that scope
concrete; it does not claim that the feature has shipped.

## Maintenance baseline

- Continue in this checkout on `codex/traffic-stats-rewrite`; no new worktree.
- Official base: `upstream/v2.5.8`, commit `4337bd85758d54d7b9044b2da3c9ac1176eae1f3`.
  The official latest-release API still reports v2.5.8 on 2026-10-19.
- Keep `feature/traffic-stats` as reference only. Do not merge its snapshot.
- Use upstream's `verge-dev` application identity for development. Never launch
  the ordinary release identity to exercise development data. Do not copy live
  profiles, change the running daily proxy, or clear the application directory.
- New storage is `traffic-statistics/v1` under the owning application directory.
  It has no old-directory fallback or migration. The directory and schema remain
  stable across subsequent custom releases; schema changes require a separate
  preservation and rollback decision.
- Integration points: backend startup and shutdown, command registration,
  service transport, navigation, translations, and custom update identity.
  Everything else belongs in the dedicated statistics modules.
- v2.5.8 is still the latest suitable release. A later-tag merge rehearsal is
  pending, not verified. Follow [the release workflow](upstream-release-workflow.md).

## Reading order and layout

Use the existing Material UI typography, spacing, theme and focus treatments.
The statistics page has its own navigation entry beside Connections.

```text
Traffic statistics                        Refresh  Export  Manage
Today | 7 days | 30 days | Custom       Oct 19 — Oct 19 · local timezone
Collection on · Updated 14:32             Coverage: partial [Details]

Total                    Download                  Upload
2.41 GB                  2.20 GB                   214 MB
Recorded traffic includes managed direct connections. Not a provider bill.

[Search target, application, process or path…]   [Policy groups (2)]
Selected: Work ×   DIRECT ×                         Reset filters

Traffic over time                     Total | Download | Upload
Continuous, keyboard-accessible time buckets; gaps remain visible
Legend: leading objects · Remaining objects (count) · Unattributed

Targets | Applications / processes | Policy groups     Combination details
Object                         Current metric ↓   Share of filtered traffic
Full readable name             612 MB             25.4%  ━━━━━
Additional identity            [Open details]
Showing 50 of 183 objects                         Show all 183
```

At narrow widths actions wrap, summaries stack, and filters remain above results.
Only the table scrolls horizontally, with a visible border; the whole page must
not acquire horizontal overflow. A detail panel becomes a full-width dialog.
Long object names wrap. Paths are selectable in details with explicit Copy
buttons; a tooltip is never the only way to read a name. Dark mode uses theme
surfaces and text, with no color-only status or selection indicators.

## Applied query and drilldown

One immutable applied query controls summary, trend, ranking, shares, detail and
export. It contains UTC start inclusive/end exclusive, display timezone, selected
groups, literal search, dimension and metric. Draft custom dates do not change
results until Apply. Limit the range to 366 local calendar days. Dates use local
calendar arithmetic, not multiples of 24 hours. Resolve quick presets again on
refresh, page resume and midnight; show the actual resolved dates.

Group selection is a union. All groups is a distinct state from an explicitly
empty selection. The menu offers Select all, Restore all, and individual toggles.
Selected chips stay visible even if a group has no records in the new range.
Options come from all retained group identities plus selected identities, never
from the visible top 50. Search matches only stored target, trusted application
name, process name, path and group. Empty selection or unmatched text yields
"No matching records" with Clear filters. A period without samples yields
"No collection records for this period" instead.

The default metric is total bytes. Metric changes reorder default ranking and
change trend and percentage meaning together. Explicit name/numeric ordering
persists until Default order is restored. The summary always labels total,
download and upload separately. Shares divide by the filtered metric total;
zero denominators display an em dash, never a fabricated percentage.

Opening an object shows its exact identity, traffic, related objects, groups,
time distribution and completeness. Opening a time bucket adds that interval.
Drilldown adds structured identity predicates to the applied query; it must not
replace a full identity with a text search. A visible breadcrumb explains the
additional scope. Export includes this scope. Closing details preserves the
page's filters, ordering, limit, scroll position and trigger focus.

Combination details retains the tuple (target, process identity, policy group,
route) with all byte columns. Do not force users through this view for ordinary
analysis. Top 50 is a presentation limit applied after full aggregation and
filtering. Show remaining count and Show all; never discard records to enforce
that limit. Missing-field and unattributed rows remain discoverable separately.

## Identity and category vocabulary

| Category | Meaning | Available evidence and action |
| --- | --- | --- |
| Target | Recorded host, otherwise recorded destination IP | Show exact value and Copy; do not resolve historical IPs to guessed hosts |
| Application / process | Trusted application metadata if obtained; otherwise original process name | Exact process name and path remain available; path distinguishes same-named executables |
| Name only | Process name exists but path is unavailable | Label this limitation; do not claim a verified software identity or merge with a known-path executable |
| Unknown target / process / group | That field was not recorded | Preserve all other known fields; explain privacy setting or missing source field when known |
| Unattributed traffic | Global byte delta has no corresponding connection detail | Included in unfiltered totals; has no invented process, group, target or route |
| Remaining objects | Real objects folded for display | Show count and expand; fully retained in query/export |

Do not infer a friendly software name from an executable filename. Shared hosts
are identified as processes unless a trustworthy source provides more detail.
Paths are identity evidence, not proof that two executables belong to one app.
Keep route (direct/proxy/unknown) separate from the group name: a group can
select DIRECT. The terminal entry in the observed core chain determines the route;
the outermost entry supplies the group/outbound label. Nested entries are not
counted again as independent copies of the same traffic. Never label every policy
group as proxy traffic. When a group cannot be determined, a selected-group
query excludes that traffic and explains the exclusion. An unattributed ratio
is shown only where its numerator and denominator have the same scope.

## Time, collection and persistence

Backend collection runs independently of whether the window/page is visible.
Use cumulative global and connection counters, not sampled speed integration.
On first connection, reconnect, core counter reset, pause/resume or successful
clear, establish a fresh baseline; do not charge lifetime bytes from that first
snapshot. Associate connection baselines with both ID and connection start.
Normal successive snapshots count only nonnegative deltas. A global reset
invalidates that interval. Reconnect does not fill gaps with guessed detail.

Assign a sample interval to its end bucket and disclose this sampling precision;
never imply exact packet timestamps. Capture UTC endpoints and local offset at
observation. Global delta minus attributed deltas becomes unattributed. If
connection totals exceed the global delta, preserve the measured global total
and classify the interval as inconsistent rather than silently inflating totals
or inventing a proportional split. This case needs a reproducible core fixture
before enabling production collection.

Retain original tuples with sample-end minute attribution inside hourly storage
files; no ingest-time top-N collapse. Minute boundaries support local calendar
dates in timezones whose UTC offsets are not a whole number of hours.
Persist sampling coverage intervals separately from byte records so a sampled
zero and an unsampled gap remain distinguishable. A day with one sample is
partial, not complete. Charts use continuous buckets and interval coverage,
including first/last partial buckets, pauses and core disconnections. UTC query
boundaries preserve an instant's meaning through timezone changes; show the
query timezone and explain differing recorded offsets when relevant.

Persist through a serialized owner. A successful response must reflect durable
state. Flush before stopping collection and before orderly shutdown; failed
writes remain visible and retryable. Loading tolerates individual unreadable
new records with explicit incomplete status, while preserving readable records.
Do not overwrite unsupported records or silently initialize over failed reads.
Use an atomic manifest/generation boundary for Clear, so partial deletion is
reported and pre-clear buffers cannot restore cleared bytes. Keep current
connection counters as a new baseline after clear. Retention removes only this
new statistics store, never profile/subscription/configuration files.

## Data management and export

Manage opens a dialog: collection switch, retention days, target recording,
process recording, and Clear all statistics. Privacy changes affect future
records only; explain that existing records remain until expiry/clear. Pausing
flushes observed data and never backfills the paused interval. The clear
confirmation explicitly covers every date and filter, preserving preferences
and all non-statistics data. Buttons remain disabled while their mutation runs;
failure retains authoritative state and offers retry.

Export the applied query snapshot, including drilldown, into a UTF-8 JSON file.
It contains schema version, generated time, UTC boundaries, timezone, group
selection semantics, search, dimension, metric, ordering, coverage and read/save
warnings, complete matching tuples, object summaries and continuous time buckets.
Byte values remain integers. Presentation limits never enter the export query.
If a snapshot contains unsaved records, export is disabled until saving succeeds;
an incomplete-read acknowledgement cannot turn unsaved data into saved records.
Label export format in the action. A single snapshot supplies both the visible
result and export; if fresher data is wanted, Refresh first. A failed save is
not success, cancellation is neutral, partial source reads require an explicit
incomplete-data acknowledgement. JSON is the initial format; spreadsheets are
not a dependency or required enhancement.

## State and accessibility contract

| State | Visible behavior | Action |
| --- | --- | --- |
| First use | Explain collection scope and that recording starts now | Start collection |
| Initial loading | Labeled progress; no fabricated zero cards | Wait or retry after failure |
| Refreshing | Preserve prior result and its applied scope | Disable overlapping refresh |
| Refresh failed | Previous result, original update time, stale notice | Retry |
| Observed zero | Zero cards plus observed coverage | Inspect interval |
| No samples | Gap treatment and no-record explanation | Change dates / start collection |
| No match | Keep visible active conditions | Clear filters |
| Collection off | History remains; pause time explained | Resume |
| Identity recording off | Explain future-field omission near affected view | Manage |
| Partial coverage | Persistent compact warning; interval reasons in details | Inspect coverage |
| Read / save failure | Distinguish unreadable saved records from unsaved current data | Retry; no silent overwrite |
| Export / clear in progress or failed | Specific operation and actual outcome | Retry or cancel |

Use named buttons and inputs, visible focus, semantic tables and dialogs. Trend
buckets are focusable buttons with time, amount and coverage in accessible names;
Enter/Space opens details. Legends include text and a focus/selected marker.
Escape closes details and returns focus. Announce async outcome changes without
moving focus. Dialog content and long paths scroll independently of actions.

## Implementation sequence and evidence

1. Reviewable isolated page design using synthetic records, including dark and
   narrow layouts. It cannot invoke Tauri, start a core or persist user data.
2. Pure query contract and byte/coverage model with focused fixtures proving
   union filters, same-name identities, complete export and long-tail ranking.
3. Backend collector/store, including reconnect, reset, pause, clear and write
   failures. Verify each against deterministic connection snapshots.
4. Integrate the Material UI page through services/mutate and registered backend
   commands; keep subscription ownership and wire contracts aligned.
5. Exercise the built development app, then package with explicit custom version
   identity and update behavior. Do not publish an official-updater-enabled
   daily package as the finished custom release.

The design preview is evidence for interactions only. It does not establish
collector correctness, persistence, native clipboard/save dialogs, installation
safety, or future upstream compatibility. Record actual results separately as
each implementation stage becomes runnable.

Official release evidence: [v2.5.8](https://github.com/clash-verge-rev/clash-verge-rev/releases/tag/v2.5.8).
