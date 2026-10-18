# claude-plugins

Plugins for [Claude Code](https://claude.com/claude-code).

## resume-agents

Restarts background subagents that a usage limit stopped, as soon as the limit resets.

Claude Code can already continue the **main** session after a usage limit resets: turn on
**Continue automatically at usage limit** in `/config` (`"autoContinueAtUsageLimit": true` in
`~/.claude/settings.json`). Subagents and background agents that the limit stopped are not
covered by that setting: they stay stopped until someone messages them. This plugin covers them.

### How it works

- When a subagent's turn ends on the usage limit, the plugin remembers that agent.
- It reads the reset time of the full window (5-hour or weekly) from Claude Code's own
  rate-limit readings, and waits until 90 seconds after it. When no window says when it
  resets, it retries after 5, 15, 30 and then 60 minutes.
- At that time it sends each stopped agent a message to continue from where it stopped, and
  to re-run any command that was cut off before trusting its result.
- It never restarts an agent you stopped yourself, one that finished, or one that failed for
  another reason. It gives up on an agent that hits the limit 3 times in a row.
- The main session is left to Claude Code's own setting, so nothing is resumed twice.

The status line shows how many agents are waiting and when they restart.

### Install

At the prompt of a Claude Code terminal session:

```
/plugin install resume-agents --marketplace JohnGrey0/claude-plugins
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter).

From a shell:

```
claude plugin install resume-agents --marketplace JohnGrey0/claude-plugins
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then
Plugins, Add marketplace with `JohnGrey0/claude-plugins`, then Add plugin.

### Use

| Command | What it does |
| --- | --- |
| `/resume-agents` | Shows the agents waiting for the limit and when they restart |
| `/resume-agents now` | Restarts the waiting agents now |
| `/resume-agents cancel` | Forgets the waiting agents |
| `/resume-agents off` / `on` | Turns the plugin off or on for this session |

### Limits

- The session must stay open: Claude Code runs the plugin only while it is running.
- An agent is restarted only if Claude Code still lets it be messaged: an agent that a person
  stopped cannot be resumed.
- The plugin only works where Claude Code reports a usage limit, which is a claude.ai
  subscription. API-key usage has no plan reset to wait for.

### Develop

```
claude plugin validate plugins/resume-agents
claude plugin test plugins/resume-agents
```

## License

MIT
