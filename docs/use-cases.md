# What rewound is actually for

Five real recall moments, reproduced from testing against a real 371,000-message corpus.
(The screenshots in the README use a small synthetic corpus — your data never leaves your
machine, so ours doesn't either.)

## 1. "This bug again — didn't we fix this months ago?"

```
rw search "port conflict"
```

Top hits: four distinct sessions, each led by a human sentence — "the daemon is
conflicting with the existing live daemon on port 4000", "22 is definitely conflicting
with the windows ssh port". One resume command later you're reading the fix you already
wrote. rewound ranks *your words* above tool output that merely mentions the term, and
shows one best hit per session so the list spans distinct moments, not one chatty session.

## 2. "What did we decide about X?" — project-scoped memory

```
rw search "retry backoff" --project checkout-service --since 30d
```

Cross-cutting terms appear in every project's sessions; `--project` and `--since` turn a
fuzzy memory ("sometime last month, in the payments repo") into a two-flag query.

## 3. The agent remembers for itself (MCP)

Add rewound's MCP server to Claude Code and "how did we solve this last time?" becomes a
tool call the agent makes mid-session: `search_history` → ranked excerpts with a
`match_uuid` → `get_session_excerpt` centers the transcript on the exact moment. In our
testing, an agent asked about a file-offset race condition retrieved the month-old session
where that exact concurrency design was discussed — without the human remembering it
existed.

## 4. The session Claude Code already deleted

Claude Code prunes transcripts after ~30 days. rewound's index is permanent: sessions
whose source files are gone stay searchable as *archived* sessions. The best time to run
`rewound index` was a month ago; the second-best time is now (`@hourly rewound index` in
cron makes it automatic — incremental runs take milliseconds).

## 5. What did all of this cost?

`rewound stats` rolls up token usage per project, valued at API list prices. On a heavy
corpus this number is startling — think tens of thousands of dollars of API-equivalent
usage on a flat-rate subscription — which is exactly why it's labeled *estimated API
cost*: it's what your usage would have cost, not what you paid. Great for knowing where
your tokens actually go.
