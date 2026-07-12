# Show HN draft

**Title:** Show HN: rewound — grep for everything your AI coding agent ever did

**Body:**

I use Claude Code daily and had 2+GB / 3,300+ session transcripts sitting on disk with zero search. Finding "the session where we fixed the auth bug three weeks ago" meant manually opening JSONL files. Worse, Claude Code deletes transcripts older than 30 days by default (`cleanupPeriodDays`, swept at startup), so that history eventually just disappears.

rewound indexes every session transcript into a local SQLite/FTS5 database and gives you three ways to search it:

- A CLI (`rewound search "fts5 trigger bug"` — ripgrep-style output, resume hint included)
- An MCP server, so the agent itself can search its own past sessions mid-conversation (`search_history`, `get_session_summary`, `get_session_excerpt`) — this is the part I actually use the most now; "how did we solve this last time" is now a tool call instead of me digging through files
- A local web UI (`rewound serve`) — phone-friendly, server-rendered, no build step. I bind it to my tailnet and search my transcript history from my phone

Everything is local — no telemetry, no account, no network calls. It reads `~/.claude/projects` read-only and writes its own DB to `~/.rewound/`. Indexing is incremental (append-only JSONL, so re-indexing after a session is milliseconds), and it keeps history around ("archive mode") even after the source transcript gets pruned.

Numbers from my own machine: cold index of 3,310 files / 368,687 messages in 30 seconds, incremental re-index in 148ms, search in 5ms.

One anecdote that sold me on my own tool: mid-session, an agent hit a byte-offset race condition while writing rewound's own indexer. It called `search_history("TOCTOU byte offset race")` and found a session from a month earlier where an agent had already analyzed the same bug class in a different project — the fix pattern was right there in the excerpt.

Claude Code only, for now — adapter architecture is built to add Codex/Cursor/OpenCode later. Free for personal use; source-available ($29 license for commercial use, honor system for now).

Feedback very welcome, especially on the MCP tool design — I'd like to know what other tools people would want their agent to have over its own history.
