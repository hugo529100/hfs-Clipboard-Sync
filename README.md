

https://github.com/user-attachments/assets/21ca1877-1fbd-406a-882a-ff3f3e37908b





# Clipboard-Sync (HFS 3 cross-device clipboard)

Share the HFS cut/paste clipboard between every browser and device logged into the **same HFS account**: cut a file on device A, and the native `#clipBar` on device B immediately shows the same clipboard. Pressing **Paste** on B makes the server move the files into B's current folder.

When the same account has **two or more visible pages anywhere**, list-changing actions refresh only the pages whose current address exactly matches an affected address. Move/copy/paste treat the source and destination folders as the two affected ends; both ends refresh. Addresses unrelated to the operation are never refreshed. A single-page account never enables this refresh-list traffic. Clipboard sync itself is **not** gated by any of this, so cut/paste still works across devices and across different directories.

- Plugin folder: `Clipboard-Sync` (no `hfs-` prefix)
- GitHub repo: `hugo529100/hfs-Clipboard-Sync`
- Requirements: HFS 3.4.x (plugin API 12+), logged-in account; guests are never synced

## Install

1. Put the whole `Clipboard-Sync` folder into HFS's `plugins` directory:
   `C:\0THER\HFS3\plugins\Clipboard-Sync\`
2. Enable **Clipboard-Sync** in the HFS admin → Plugins page.
3. Reload the frontend page (the plugin JS/CSS is injected at page load).

When installed from GitHub, HFS turns the `hfs-Clipboard-Sync` repo into the `Clipboard-Sync` folder, matching HFS conventions.

## Usage

1. Device A (for example Chrome / Windows) logs in as `alice` and uses right-click → **Cut** on a file.
2. Device B (for example Firefox / macOS) logs in as `alice` and opens the destination folder:
   - The native `#clipBar` immediately shows `Clipboard (N items)`; no extra indicator is added by this plugin.
   - Press **Paste**: the server atomically claims that clipboard version and performs the move; the clipboard then disappears on every device.
3. Press **Cancel clipboard** on any device to clear the shared clipboard everywhere.
4. **Back to source folder** still works normally.

### List refresh on affected addresses

- Refresh traffic is enabled only while the account has **2+ visible pages** somewhere. A single-page account never triggers it.
- Every operation has affected addresses:
  - delete/comment/rename/create/upload: the folder being changed;
  - move/copy/paste: **both ends** — the source folder(s) and the destination folder.
- Only pages whose current address exactly equals an affected address reload:
  - A and B both on `/Music/`: a comment/delete/paste refreshes both.
  - A on `/src/`, B on `/dst/`, any device moves/copies/pastes from `/src/` to `/dst/`: **both** A and B refresh, even when each address has only one page.
- Pages on unrelated addresses receive nothing that causes a reload. For example, a page on `/other/` stays untouched by a `/src/` → `/dst/` operation.
- A hidden tab does not count as a visible page. When it returns to the foreground it catches up by itself.
- If a page is showing a file in HFS's full-screen viewer (`file-show`), that page **defers** its list refresh and applies one queued refresh when the viewer closes. Other affected pages refresh normally.

Clipboards produced by plugins such as `copy-files` (`state.clip.__copy`) are intentionally not synced, so a copy is never turned into a move.

## Design: UTC queue + atomic paste claim

- The server is the single source of truth. Every accepted operation is stamped with the server's UTC clock (`at`, epoch milliseconds) and a strictly increasing version. This UTC timestamp is the only ordering key of the operation queue — it is kept **internal** and is not shown in the UI.
- Each account has its own clipboard record and operation queue. Accepted operations across all accounts are spaced by a fixed 50 ms on the shared UTC timeline, so different accounts never share a queue slot. The spacing is capped at 1 second ahead of real time to keep stale checks sane. This and every other time-related value is fixed in code, not configurable.
- Account isolation is enforced at every layer: state is keyed by username, live channels are per account, each snapshot carries an `account` tag that the client verifies, and guests are rejected with HTTP 401 on every plugin API. A browser session that logs out tears the sync down immediately.
- Clients receive `serverNow` with every snapshot and use it to compensate their own clock skew (`clientAt`). The server only treats it as the intent time and rejects stale intents; it never trusts client clocks for ordering.
- Every operation carries an `opId`; the server remembers the latest 200, so automatic retries cannot execute twice.
- Paste is not performed independently by each client:
  1. The client claims a `version` through `_clipSync_paste`.
  2. The server checks the version, confirms no other device is pasting, and performs the move in the **same request** with HFS core `moveFiles`, under the caller's permissions.
  3. Once a version is claimed, other devices only get `busy` / `stale`, so the same clipboard is pasted **only once**.
- If a device dies mid-paste, the fixed 30-minute claim lease expires before another device can take over.
- Live updates use HFS's built-in `get_notifications` SSE with a per-account channel, plus a fixed 20-second fallback poll and a catch-up pull when the tab or network comes back.
- Presence: each page sends a heartbeat every 20 seconds (fixed) with its current path and visibility. The server tracks visible pages per account. A single `detectListChange` path covers delete (HTTP DELETE), PUT/multipart upload, comment, rename, create-folder and move/copy; the custom paste endpoint adds its source/destination paths. A `refresh` is sent for an affected address only when the account has 2+ visible pages and at least one visible page is on that exact address. Clients apply a refresh only when their current address matches the event path, so unrelated addresses never reload. A single-page account never produces refresh traffic. Presence lives in memory only.
- A page that is displaying HFS's full-screen file viewer excludes itself from reloading: the received refresh is queued and executed once after the `.file-show` viewer is closed. Pages without the viewer reload immediately.
- Refresh events carry an incremental patch: `comment`/`folderComment` update the entry or current-folder comment in place, `renamed` replaces just that entry, `removed` splices entries out, `added` appends the new entries, and move/copy/paste/upload send one patch per affected address. The client mutates `state.list`/`state.filteredList` directly, so comment, rename and delete no longer reload the page at all. A full list reload is only the fallback when a patch is missing, the page is in search/filter mode, or an entry cannot be rebuilt safely.
- Clipboard state is persisted in `plugins/Clipboard-Sync/storage/clipboard.db` and survives HFS restarts.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Only for accounts | Empty | Empty = every logged-in account; guests never sync |
| Show toast notifications | On | Off suppresses the plugin's toast messages; error dialogs remain |
| Refresh list for affected addresses | On | Only pages on the exact affected address reload; move/copy/paste refresh both ends; unrelated addresses never refresh |
| Debug logging | Off | Plugin log and browser console |

All time-related values (20 s poll/heartbeat, 90 s presence TTL, 50 ms queue gap, 30 min paste lease, 2 s stale tolerance) are fixed in code and cannot be configured. This keeps one behaviour to debug and avoids configuration drift.

Reload the page after changing settings (frontend settings are read at page load).

## Files

```
Clipboard-Sync/
├─ plugin.js              # server: state, UTC queue, paste claim, SSE, permissions
├─ public/
│  └─ main.js             # frontend: state.clip hooks, paste interception, presence/refresh
├─ tests/
│  ├─ server.test.js      # server logic tests (mocked HFS API)
│  ├─ frontend.test.js    # frontend simulation (vm + fake HFS)
│  ├─ sse-check.js        # live SSE check against a real HFS (needs cookie)
│  └─ browser-check.js    # optional Chrome remote-debugging page check
└─ README.md
```

## Tests

No npm required:

```bat
node tests\server.test.js
node tests\frontend.test.js
```

Optional live SSE check against a running test HFS:

```bat
node tests\sse-check.js http://127.0.0.1:8899 <channel> "<cookie header>"
```

## Limitations

- Only cut/cancel/paste are synced; copy clipboards stay local by design.
- Paste is executed by the server, so files must be inside the same HFS VFS (they always are).
- If two devices press Paste at the same time, only the first claim runs; the other gets "Another device is pasting this clipboard".
- If HFS crashes mid-paste, already-moved files are not rolled back (same as native HFS behaviour).
- The frontend page must stay open to receive live updates; reopening the page pulls the latest clipboard.
- Refresh-list only works with the same account, an affected address, and 2+ visible pages. A list refresh reloads the whole list and may reset an in-progress selection.
- Incremental additions (create/upload/move/copy/paste) are appended without waiting for size/time metadata, so they may show an empty size and sit at the end of the list until the next full reload. Search/filter mode falls back to a full reload.
- Only changes made through HFS APIs / HTTP DELETE are covered. Files changed directly on disk by external programs (outside HFS) do not trigger a refresh.

## Version

- 1.9 — Added a Show toast notifications switch; removed the redundant Enable switch; incremental patches avoid extra full-list flashes.
- 1.8 — All time-related tuning is fixed in code; removed poll/lease/queue-gap settings.
- 1.7 — Incremental list patches (comment/rename/delete/create/move/copy/paste/upload) update entries in place; full reload only as fallback.
- 1.6 — Account isolation hardening: guest API rejection, account-tagged snapshots, and fixed global queue spacing between accepted operations.
- 1.5 — Refreshes only the exact affected addresses; move/copy/paste refresh both source and destination ends; unrelated addresses never refresh.
- 1.4 — Removed the extra status pill; the native clipBar already shows the clipboard item count.
- 1.3 — Unified list-change detection (delete/upload/comment/rename/create/move/copy/paste); a page showing a file defers its refresh until the viewer closes.
- 1.2 — English-only UI; removed the visible UTC/version queue labels (kept internal).
- 1.1 — Same-page list refresh when 2+ visible pages share a path; clipboard sync remains independent.
- 1.0 — First release: cross-device clipboard, UTC operation queue, server-side paste claiming, status indicator, persistence.
