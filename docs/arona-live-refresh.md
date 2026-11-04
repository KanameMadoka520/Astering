# Arona live refresh

When Arona changes data, the open pages follow without a reload and without refetching
whole views. The logic lives in `frontend/src/client/queries/tcyConversations.ts`; task
changes reuse the server-change helpers in `taskMutations.ts` / `taskCache.ts`.

## Receipts

A receipt is one successful write action of a turn: tool name, parsed arguments and parsed
result. Read-only tools (`list_*`, `get_*`, `find_tools`, `ask_user`, `web_search`,
`invoke_tool`) and failed actions are not receipts.

Each receipt has the key `<turn id>:<action index>`. A ledger remembers the keys per
conversation:

- The first time a conversation is observed its existing receipts are only recorded. Opening or
  switching back to an old chat replays nothing.
- A conversation created in this tab (`useCreateConversation`) starts with an empty ledger, so
  its first receipts apply.
- The ledger belongs to one query client and one account: it starts over when the signed-in
  identity, the session epoch (every logout) or the API base changes. The query client survives a
  logout, so without that another account could inherit or suppress receipts.
- The `/ai` page, the floating panel and the app-level run observer share the ledger, so a receipt
  applies once whoever sees it first, also across conversation refetches and hand-overs.

`useAgentReceiptRefresh(conversation)` (assistant views) and the run observer turn new receipts
into a plan (`planAgentRefresh`) and run it through `agentRefreshMutationOptions`, which writes
caches only in mutation callbacks.

## What a receipt refreshes

| Tool | Cache effect |
| --- | --- |
| `create_task` | `applyServerTaskChanges` (as `applyServerTaskCreated`): the card is put on open boards of its project (default or echoed bucket) once, even if the receipt is seen twice, then those boards are reconciled with every loaded page. Without a task in the result, open lists refetch. |
| `update_task`, `bulk_update_tasks` | As `applyServerTaskUpdated`: every cached copy is patched unless a newer copy (by `updated`) is cached, and done buckets follow `done`. Without a task in the result the named task detail refetches. |
| `delete_task` | As `applyServerTaskDeleted`: an open detail switches to its deleted state (`TaskDeletedError`), cards go with totals and bucket counts adjusted. |
| `add_task_label`, `remove_task_label` | Label patched from the labels cache; an unknown label fetches that task's labels. |
| `assign_task`, `unassign_task` | Unassign filters the assignee; assign fetches the task's assignees. |
| `relate_tasks`, `unrelate_tasks` | Both tasks' relations fetched; mounted lists refetch. |
| `add_comment` | The task's comment list refreshes and its comment count is read from the server, never `+1` locally (a concurrent full read may already count the comment). |
| `create_label` | Appended to the labels cache. |
| `create_project`, `update_project`, `set_project_completed` | Merged into the navigation list and project detail, keeping views and permissions. History and timeline only for completion, title or colour changes. |
| `check_in_task_routine`, `configure_task_routine` | The returned task goes through `applyServerTaskChanges` like `update_task`; that task's routine summary and history queries are invalidated (only mounted ones refetch). `done` never moves with a routine, so done buckets stay put. |
| `update_project_announcement` | Only that project's announcement query (`['project-announcement', id]`) is invalidated; navigation, history and timeline are untouched. |
| Unknown write tool | Named task (`id`/`task_id`) and project (`project_id`) refetched, lists marked stale, project list, history and timeline invalidated. |

All task changes of one batch of receipts go through `applyServerTaskChanges` together, so open
lists and boards refresh once per batch instead of once per task:

- Open lists refetch when a filter may now include or exclude the task: global and pseudo-project
  (saved filter, favourites) lists always, project lists only for the projects the batch touched
  (the task's old and new project). Lists of other projects are not requested. The timeline is
  invalidated the same way and refetches only while mounted.
- Cards are patched in place first. Open boards that the patch cannot settle are then reconciled
  through `kanbanServerRefresh.ts`: the bucket list plus every page each bucket had loaded, through
  the board's own filters, so loaded depth stays. That covers creates and deletes (counts and pages
  shift), moves between projects, saved-filter boards, boards with a search, a view filter or
  filter buckets, and moves to another bucket. A plain field change or a completion on an
  unfiltered board needs no request. The board scope is read before patching, while a moved or
  deleted card still shows where it was. A board is never reset to its first page.
- If a reconciliation fails, the patched board stays on screen, is marked stale (so it reloads when
  opened again) and a toast says the change was saved but the board may be out of date. Aborts from
  an account or API switch are silent.

Local saves and receipts: every applied task receipt is recorded per task with a sequence number
(scoped to the account, session and API). A local save takes the current sequence when it starts; its
PATCH answer is dropped from the caches and the open detail only when a receipt recorded after that
mark wrote a newer `updated`, i.e. a receipt that arrived while the save was in flight. Copies loaded
earlier and receipts applied before the save started never block it, so finer timestamps on loaded
copies cannot undo a save answer that carries whole seconds. Ordinary GET responses are not recorded.

Comment notifications (websocket) refetch the task's comments. A first comments read still in flight
when the event arrives is cancelled and read again, because an invalidation would only join that
earlier read and commit its pre-comment answer as fresh.

The project edit form and project draft are not touched, so an unsaved draft is never overwritten.

Fetched embedded data (labels, assignees, relations, comment count) is patched field by field and
never overwrites newer data: a response is dropped for a field a newer request asked for again,
for a cached copy whose field changed while the request was in flight (a user edit, a fresher
response), and entirely when a cached copy is newer than the response.

## Following a run

The server owns each model job by account and conversation. Different conversations can run or
compact independently; one conversation still has a single active writer. A view or a successful
send, review or compaction response registers that conversation in the account/session's live set
(IDs only, kept in `sessionStorage` for a reload, including legacy single-ID hints).

- `useAronaRunObserver()` (mounted once in `ContentAuth.vue`) follows each live conversation while no
  assistant view shows it: after starting a run on `/ai` and moving to a project, receipts keep
  applying without opening the floating panel. A stable effect scope owns each conversation's
  stream and query, never the history. Finishing, losing access to, or viewing one chat removes
  only its observer; the others remain connected. Authentication-context changes dispose all
  previous observers, while normal same-account token refresh preserves them.
- Event stream (`conversationEvents.ts`): the server ends every stream after 25 seconds. After a
  stream that stayed open (≥ 10 s) and ended cleanly the client reconnects at once and stays
  live; a short stream that delivered state retries after 1.5 s; an empty or failed one backs off
  (1.5 s doubling up to 30 s).
- The conversation GET polls every second only while a turn runs or a compaction is in progress,
  and only while the event stream is not live.

See [conversation concurrency](agent-concurrency.md) for server locking, cancellation and cleanup.
