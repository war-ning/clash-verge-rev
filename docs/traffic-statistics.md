# Traffic statistics v1 — development build

This rewrite starts with new statistics. It does not read, migrate or delete the
previous statistics store. It is based on official v2.5.8 and retains its history.
The interaction and accounting decisions are in [the design](traffic-stats-design.md).

## Use

Open **Traffic statistics** beside Connections. Collection is initially off;
enable it in **Manage collection**. It runs in the backend while the window is
hidden. The page refreshes manually. Today, 7 days and 30 days resolve again when
refreshed and within 30 seconds of midnight or a timezone change. Custom dates
require Apply; an unapplied draft never changes export scope.

The three cards show all matching bytes, download and upload. Select a trend
metric and a ranking dimension to inspect targets, processes or policy groups.
Search matches the actual stored target, process name, executable path and group.
Group selection is a union. Restore all also includes groups discovered later;
Select all selects the currently available identities. Select none matches no
groups. An unavailable selected group remains visible and removable.

The first view shows 50 ordinary objects and keeps missing-identity/unattributed
categories separate. Show all makes all ordinary objects accessible through
pages of 50. Combination details also pages the complete matching tuples.
Pagination changes neither totals nor export contents.

Click an object or a time bucket for details. Names and paths wrap, remain
selectable, and have explicit Copy controls. A filename is shown as a process,
not an independently verified software identity. Different executable paths
remain separate; a missing path is not the same as a missing process name.

Export JSON uses the exact applied snapshot and current detail scope. It includes
all matching records, summaries, hourly buckets, query conditions, metric,
integer byte units, sampling intervals, privacy settings and warnings. It does
not fetch a different snapshot behind the page. Refresh first for newer data.
Unreadable-source warnings require acknowledgement. If current records could
not be saved, export is disabled until a refresh successfully saves them.

Collection/privacy switches affect future observations; existing history remains.
Pause saves the observed data. Resume establishes a new baseline rather than
backfilling paused traffic. Clear requires confirmation and clears all dates and
filters, preserving settings, profiles, subscriptions and proxy configuration.
A failed physical deletion is reported even after the active generation clears;
Clear can be retried to remove the remaining old generations.

## What the numbers mean

This measures traffic managed by the core, including direct connections. It is
not a provider bill or a measurement of all traffic on the computer.

The collector reads cumulative connection/global counters once per second.
First startup, reconnect, clear and changed collection settings establish a new
baseline. Deltas are assigned to the sample-end minute inside hourly storage
files. Queries display continuous hourly buckets, compacted by calendar day for
longer charts. Export retains the hourly series and every minute-level tuple.
An interval crossing a minute boundary is assigned to its endpoint; these are
sampling timestamps, not exact packet timestamps.

Newly observed connections are charged to their identities only when their
recorded start is inside the observed interval. Otherwise their lifetime bytes
are not assumed to belong to that interval. Missing final samples and short
connections can produce a global residual: **Unattributed traffic**. Missing
individual fields retain their other known identities. A group-filtered total
excludes bytes whose group cannot be determined and explicitly says so.

If connection deltas exceed the global delta, that interval preserves the global
bytes as unattributed and is marked inconsistent. It does not invent a scaled
allocation or inflate totals. Source errors, counter resets and intervals over
five seconds do not backfill a gap with guessed bytes. Coverage records distinguish
an observed zero from a missing interval; one sample does not establish a full day.

UTC timestamps and recorded local offsets are retained. Applied queries preserve
their display timezone, including when refreshing a custom range after a system
timezone change. Reapply custom dates to use the new local calendar. Time labels
include timezone abbreviations/offsets to distinguish repeated daylight-saving
hours. Custom ranges allow at most 366 inclusive calendar days.

## Storage and updates

New data is owned exclusively by `traffic-statistics/v1` below the application's
data directory. Development must use `verge-dev` (the upstream `.dev` application
identity); a branch name alone does not isolate runtime data. The preview described
below uses memory only and starts no core or service.

The versioned manifest selects a generation and stores settings. Hourly files
contain minute-attributed tuples and actual coverage intervals. Updates replace
files atomically, after synchronizing their contents. Background persistence and
retention run every minute, including while paused or disconnected; opening the
page and changing settings also flush data. Orderly quit/restart flushes before
core cleanup. A crash or forced termination can lose the last unflushed minute.

Unreadable hourly files are reported alongside readable records and are not
overwritten. An unreadable/missing/unsupported manifest refuses initialization
rather than resetting a nonempty store. Preserve the directory and investigate
the reported error before restarting. Clearing is the explicit destructive
operation; it never operates on the parent application directory.

This branch disables official update checks, cached automatic installation and
the manual official-install command. Tauri's official endpoints are empty.
Existing daily installation settings were not edited. `custom-release.json`
identifies the upstream tag, statistics version and development/manual-update
status. This is a development revision, not an approved daily installer.
Future validated custom releases must retain this v1 store; do not clear it on
an upstream upgrade. See [the release workflow](upstream-release-workflow.md).

## Integration inventory

| Integration | Ownership |
| --- | --- |
| `src-tauri/src/traffic_statistics` | Collection baselines, tuples, coverage, store and retention |
| `src-tauri/src/cmd/traffic_statistics.rs`, `lib.rs`, `cmd/mod.rs` | Read/configure/clear commands and registration |
| `utils/resolve/mod.rs`, `feat/window.rs` | Backend lifetime and orderly flush |
| `src/services/traffic-statistics` | Wire model, pure unified query/export and mutation/transport boundary |
| `src/components/traffic-statistics`, statistics page/navigation | UI, dates, details and isolated preview |
| Statistics locale files, locale loader and generated keys | Chinese/English text; English fallback text for other locales |
| `services/update.ts`, `cmd/app.rs`, startup updater guard, Tauri endpoints | Prevent replacing the custom build with an official binary |
| `custom-release.json`, changelog | Custom source identity and user-visible change |

## Development evidence (2026-10-19)

The isolated preview is available with `pnpm web:dev`, then
`http://127.0.0.1:3000/traffic-statistics-preview.html`. It is not a production
entry and is absent from the production build. The preview shares the real page
and query implementation, supplying synthetic records instead of Tauri commands.
Its settings and clear operations change only memory. Reload restores the fixtures.

Focused query/date tests cover group unions and empty selection, same-name paths,
exact identity drilldown, long-tail ranking before limiting, complete export,
rejecting unsaved export, continuous zero/gap coverage, overlapping coverage,
invalid/366-day ranges, 23/25-hour daylight-saving dates and fixed query timezones.
Collector/storage tests cover initial baselines and resets, fresh connections,
residuals, inconsistent counters, long gaps, storage reopening, corrupted-record
protection and generation clear preserving a separate profile sentinel. They
are needed because an incorrect total or silent overwrite can otherwise look
like a successful operation.

Browser evidence includes explicit empty-group selection, Work + DIRECT union,
unmatched search, exact long-target drilldown, full target clipboard contents,
stale-result preservation after refresh failure, disabled export for unsaved
records, and a dark 420-pixel window with document scroll width equal to client
width. Pausing preserved the synthetic totals; confirming clear changed the
cards, ranking and trend to empty while retaining collection preferences. The
desktop/light layout and detail scroll boundary were also inspected.

Eight frontend regression cases and four Rust cases passed. `tsc --noEmit`,
the repository frontend lint, `cargo check -p clash-verge --features verge-dev`,
`cargo clippy-all`, `vite build` and the listen/emit/invoke architecture check
passed. The production output does not contain the preview HTML. The frontend
locale audit reports no unused, missing or extra keys in all 14 languages.
Its backend audit still reports the pre-existing English `service.legacy`
source mismatch and two missing Portuguese tray labels; they were left alone.

Remaining acceptance work: native commands and the live collector have not been
exercised together in a running development desktop session. Native save-dialog
cancellation, physical deletion failures, forced-termination recovery, sustained
large-store performance and an installed custom candidate still need real-world
exercise. A later-tag upstream merge rehearsal remains pending because v2.5.8
is still the latest suitable official release. No daily package was installed,
no subscriptions/proxy settings were changed, and no old statistics were migrated.

The upstream baseline also has an unrelated Knip finding:
`readLegacyTestUrls` is exported by `src/services/proxy-test-url.ts` without an
external use. It was not changed as part of this rewrite.
