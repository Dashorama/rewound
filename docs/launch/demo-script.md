# Demo script

Commands for a terminal-recording demo (asciinema / vhs / manual screen capture). Run each line, pause briefly on the output before moving to the next. Target length: under 60 seconds.

Use a real (or realistic) `~/.claude/projects` corpus — do not fabricate output; capture actual CLI output when recording.

1. **Set the scene.**
   ```bash
   rewound stats
   ```
   Shows total sessions/messages/estimated cost across every project — establishes "this is your real history, already indexed."

2. **Cold index, for viewers who haven't run it yet.**
   ```bash
   rewound index
   ```
   Narration: "Indexes every Claude Code session on disk. Read-only, incremental after this."

3. **The core moment: search.**
   ```bash
   rewound search "fts5 trigger bug"
   ```
   Narration: "ripgrep-style hits across every session, ever. Each one has a resume command."

4. **Filter it.**
   ```bash
   rewound search "auth" --since 7d --project myapp
   ```
   Narration: "Filter by project, by time window, by role."

5. **Show a session.**
   ```bash
   rewound show <session-id-prefix>
   ```
   Narration: "Full readable transcript, not raw JSONL."

6. **The moat feature: MCP.** Cut to a Claude Code session with rewound configured as an MCP server. Type a prompt like:
   > "Have we dealt with a database migration failure like this before?"

   Let the agent call `search_history`, then `get_session_excerpt` on a hit, and show it citing the actual prior session in its answer.

   Narration: "This is the part that matters: the agent is searching its own memory, live, mid-conversation."

7. **Close on privacy.**
   ```bash
   rewound stats --json | head -c 200
   ```
   Narration: "Everything you just saw ran against a local SQLite file. No network calls, no telemetry, nothing left this machine."

## Notes for the editor

- Keep the terminal font large enough to read on mobile (this product's own README is read on phones over Tailscale).
- Don't show real cost/dollar figures without the "estimated" label on screen — the pricing table is a rough estimate, not a bill.
- If recording against a real personal corpus, scrub any session titles/snippets that reference private info before publishing.
