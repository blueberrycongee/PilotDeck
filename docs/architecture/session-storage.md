# Cold session storage

The Gateway checks for cold transcripts one minute after startup and every six
hours thereafter. Files unchanged for 30 days are eligible. Each pass compresses
at most 32 files, skips writers open in that Gateway, and skips pending turn
replacement transactions. Main transcripts and subagent sidechains are included.

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
pilotdeck session compact --idle-days 30
pilotdeck session compact --pilot-home /path/to/pilot-home --dry-run
```

Commands print JSON with file counts, before/after bytes and failures. Dry-run
calculates compression without rewriting history. Background work is cancelled
when its Gateway is disposed.

All processes reading a shared PilotDeck home must support this encoding before
maintenance runs. Older versions and external scripts that directly expect a
`message` or `boundary` in every JSONL record must be upgraded. External tool-result
files, attachments, file backups, and user-input media are not compressed by this
pass. Real savings depend on their share of disk usage.
