# Cold session storage

Background compression is **disabled by default**. Only set
`PILOTDECK_SESSION_STORAGE_COMPRESSION=1` after backing up the PilotDeck home
and upgrading every process/tool that reads it. Without this opt-in, starting
the Gateway never rewrites existing history.

When enabled, the Gateway checks for cold transcripts one minute after startup and every six
hours thereafter. Files unchanged for 30 days are eligible. Each background pass
scans at most 32 files and saves a cursor so later passes reach the rest. It skips
writers open in that Gateway and pending turn replacement transactions. Main
transcripts and subagent sidechains are included. Fingerprints skip unchanged
files already examined, avoiding repeated full-file compression work.

History remains JSONL at its original path. Large assistant/tool messages and
context snapshots use a `pilotdeck-gzip-v1` payload; record identity stays plain.
User inputs and session metadata remain plain so bounded head/tail reads, titles,
activity ordering, and prompt previews do not require decompression. Small records
and records that do not shrink stay unchanged. This is lossless storage encoding,
independent of model-context summarization. It never prunes conversation turns.

Readers accept mixed plain/encoded records. Continuing a conversation appends
ordinary JSONL. Search, replay, web history, forked sidechains, and Always-On history
use the shared decoder. An encoded record is limited to 50 MiB decoded; the normal
history reader also applies its total read limit after decoding. Maintenance skips
files over 50 MiB, matching the default history reader limit.

Append and turn replacement share a filesystem lock with maintenance across
updated PD processes. Compression writes a private temporary file, fsyncs it,
checks the source has not changed, and atomically renames it over the source while
preserving its modification time. Dead-process locks can be recovered. An ownerless
lock (a crash during lock publication) times out rather than being stolen; remove
that `.storage-lock` directory only after confirming no writer owns it. Temporary
`.compress.tmp` files left by a process crash are not authoritative history.

Manual preview and execution:

```sh
pilotdeck session compact --dry-run
pilotdeck session compact --idle-days 30 --allow-format-upgrade
pilotdeck session compact --pilot-home /path/to/pilot-home --dry-run
```

Commands print JSON with file counts, before/after bytes and failures. Dry-run
calculates compression without rewriting history or maintenance state. Manual
commands scan all files; their unlimited budget does not use the background cursor.
Background work is cancelled
when its Gateway is disposed.

All processes reading a shared PilotDeck home must support this encoding before
maintenance runs. Older versions and external scripts that directly expect a
`message` or `boundary` in every JSONL record must be upgraded. External tool-result
files, attachments, file backups, and user-input media are not compressed by this
pass. Real savings depend on their share of disk usage.

Manual mutation requires `--allow-format-upgrade`; `--dry-run` never requires
that flag. To downgrade to an older reader, stop all writers and restore the
pre-compression backup first. The old reader cannot decode compressed records.

The scan budget bounds candidate files inspected, not directory enumeration or
a hard wall-clock duration. Directory entries sort with a slash suffix so the
resumable cursor covers main transcripts and same-stem subagent directories.
