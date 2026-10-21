<p align="center">
  <img src="assets/brand/repository-hero.jpg" alt="Command Code Go 2 DeepSeek API" width="100%">
</p>

<h1 align="center">Command Code Go 2 DeepSeek API</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F172A" alt="MIT"></a>
  <a href="#configuration"><img src="https://img.shields.io/badge/Windows-10%2B%2011-0078D4?logo=windows&logoColor=white" alt="Windows 10/11"></a>
  <a href="#configuration"><img src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodejs&logoColor=white" alt="Node.js 18+"></a>
  <a href="#configuration"><img src="https://img.shields.io/badge/PowerShell-5.1%2B-5391FE?logo=powershell&logoColor=white" alt="PowerShell 5.1+"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#endpoints">Endpoints</a> ·
  <a href="#clients">Clients</a> ·
  <a href="#differences-from-the-official-docs">Differences</a> ·
  <a href="#quota-panel">Quota panel</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#security">Security</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="README.md">中文</a>
</p>

Serves DeepSeek's three official protocol surfaces from a local endpoint, backed by a Command Code Go plan. Point `base_url` at it and keep your request code unchanged; protocol behaviour is measured against the official docs item by item.

## Why this exists

The Command Code Go plan costs **$1/month**. Their own wording is "Your $1 buys $10 of credits" — a 10x multiplier. Those credits are spent on model calls, and all of them can go to DeepSeek:

| Window | Cap |
|---|---|
| 5 hours | $3 |
| Weekly | $6 |
| Monthly | $10 |

For reference, DeepSeek's own pricing ([Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)) for Flash is ¥0.02 per million input tokens on a cache hit, ¥1 on a miss, and ¥4 for output, during off-peak hours (peak doubles it). $10 of credits works out to roughly **tens of millions of tokens per month**, which would cost $10 directly from the official API.

In short: **$1 buys the official $10 of DeepSeek usage**. The trade-off is that traffic runs through Command Code's channel under plan rate limits, not DeepSeek's own infrastructure.

The Go plan only exposes `/alpha/generate` to the official CLI; it has no standard API. This project supplies the translation layer so that $1 of quota can be consumed by any OpenAI / Anthropic / Responses-compatible client — Claude Code, Codex, opencode, pi, DSH.

This is not an official channel. Usage caps, model availability and stability are controlled by Command Code, not DeepSeek, and can change without notice. It suits personal development and experimentation, not production dependencies.

## Quick start

Requires Windows 10/11, PowerShell 5.1+, Node.js 18+.

```powershell
.\scripts\install.ps1      # install deps, generate config.json, apply protocol patches
commandcode login          # log in to the CLI, creates auth.json
.\launch.ps1               # start; the proxy lives as long as the window
```

The panel lists the three local endpoints once it's up. Optional:

```powershell
.\scripts\make-shortcut.ps1   # desktop shortcut
.\scripts\test-proxy.ps1      # self-check
npm run verify                # three-protocol parity verification
```

<p align="center">
  <img src="assets/brand/panel.jpg" alt="Quota panel: endpoints, model list with measured TPS, three quota windows" width="62%">
</p>

## Endpoints

| Protocol | Local address | Official docs |
|---|---|---|
| OpenAI Chat Completions | `http://127.0.0.1:8787/v1` | [create-chat-completion](https://api-docs.deepseek.com/api/create-chat-completion) |
| Anthropic Messages | `http://127.0.0.1:8787` | [anthropic_api](https://api-docs.deepseek.com/guides/anthropic_api) |
| Responses | `http://127.0.0.1:8788/v1` | [responses_api](https://api-docs.deepseek.com/guides/responses_api) |

Use `proxy-managed` as the API key — it is a sentinel the proxy swaps for the real key in `auth.json`. Any other value is forwarded upstream as your own key and comes back 401.

Model names may be written as `deepseek-v4-flash`, `deepseek-v4.1-flash` or `deepseek-flash`. Per the official docs `deepseek-flash` means **V4.1-Flash**, and this project matches that; `deepseek-v4-flash` and `deepseek-v4.1-flash` are two distinct upstream models, each callable directly. `/v1/models` lists everything available with its context window.

## Clients

DeepSeek publishes setup guides for eight agents. This project does not restate them — configure per the official guide, then change only the base URL; behaviour is identical.

| Agent | Official guide | What to change locally |
|---|---|---|
| Claude Code | [claude_code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) | `ANTHROPIC_BASE_URL` → `http://127.0.0.1:8787` |
| Codex | [codex](https://api-docs.deepseek.com/quick_start/agent_integrations/codex) | `base_url` → `http://127.0.0.1:8788/v1` |
| OpenCode | [opencode](https://api-docs.deepseek.com/quick_start/agent_integrations/opencode) | `baseURL` → `http://127.0.0.1:8787/v1` |
| Hermes | [hermes](https://api-docs.deepseek.com/quick_start/agent_integrations/hermes) | Base URL → `http://127.0.0.1:8787/v1` |
| OpenClaw | [openclaw](https://api-docs.deepseek.com/quick_start/agent_integrations/openclaw) | Base URL → `http://127.0.0.1:8787/v1` |
| Qoder | [qoder](https://api-docs.deepseek.com/quick_start/agent_integrations/qoder) | custom model Base URL → `http://127.0.0.1:8787/v1` |
| Reasonix | [reasonix](https://api-docs.deepseek.com/quick_start/agent_integrations/reasonix) | Base URL in the first-run wizard → `http://127.0.0.1:8787/v1` |
| WorkBuddy / CodeBuddy | [workbuddy](https://api-docs.deepseek.com/quick_start/agent_integrations/workbuddy) | `url` in `models.json` → `http://127.0.0.1:8787/v1/chat/completions` |

The API key is always `proxy-managed`.

### Switching with CC Switch

[CC Switch](https://github.com/farion1231/cc-switch) manages ten clients; eight of them accept a DeepSeek preset that can point here. Duplicate the DeepSeek preset for the target and change only the address:

| Client in CC Switch | Field to change | Value |
|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` |
| Claude Desktop | model mapping Base URL | `http://127.0.0.1:8787` |
| Codex | `base_url` in the TOML | `http://127.0.0.1:8788/v1` |
| OpenCode | `options.baseURL` | `http://127.0.0.1:8787/v1` |
| OpenClaw | provider Base URL | `http://127.0.0.1:8787/v1` |
| Hermes | `base_url` | `http://127.0.0.1:8787/v1` |
| Pi | `baseUrl` | `http://127.0.0.1:8787/v1` |
| MiniMax Code | Base URL in the model config | `http://127.0.0.1:8787/v1` |

Gemini CLI and Grok Build speak their own native protocols, which this project does not implement, so they cannot point here.

### Three things that will bite you

**Claude Code's context declaration.** It sizes context from a built-in model catalogue, so an unfamiliar model name falls back to 200k with a warning. Append `[1M]` to declare the real window; the suffix never reaches upstream:

```powershell
$env:ANTHROPIC_MODEL = "deepseek-v4-flash[1M]"
```

`CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` works too.

**OpenCode model ids must not contain slashes.** It addresses models as `provider/model`, so a slash is read as a path separator. Writing `deepseek/deepseek-v4-flash` into `models` gets truncated and returns 403. Use the flat `deepseek-v4-flash` and call with `--model ccgo/deepseek-v4-flash`.

**pi / DeepSeek Harness infer the provider from the URL.** Both run on pi-ai, which checks whether the base URL contains `deepseek.com` to pick a thinking format. A localhost address does not, so declare `compat` explicitly:

```json
{
  "compat": {
    "thinkingFormat": "deepseek",
    "requiresReasoningContentOnAssistantMessages": true,
    "requiresThinkingAsText": false,
    "maxTokensField": "max_tokens",
    "supportsReasoningEffort": true
  }
}
```

For pi, put it in `$env:PI_CODING_AGENT_DIR\models.json`.

## Differences from the official docs

All three protocols are measured item by item; `npm run verify` reproduces this:

```
PASS  OpenAI Chat Completions  0 diffs
PASS  Anthropic Messages       0 diffs
PASS  Responses                0 diffs
```

The deviations worth knowing all stem from what the upstream channel can do:

| Item | Note |
|---|---|
| Billing | Plan window credits ($3 / $6 / $10), not per-token |
| `logprobs` / `top_logprobs` | Upstream returns none; the field is empty |
| `n > 1` | Only one choice is returned |
| `web_search` tool | No server-side search upstream; ignored |
| Files API | No file storage; not implemented |
| FIM completion (`/beta`) | No such upstream endpoint; not implemented |
| Context hard-disk cache | Managed inside upstream; not controllable |

Fields the official API itself marks as "ignored" are ignored here too, without erroring. Each protocol's compatibility section in the official docs lists them; this implementation follows those lists without adding or removing entries.

## Quota panel

A static panel; nothing refreshes on a timer. Benchmarking is **never automatic** — the TPS column shows `-` at startup and is only measured when you press `T`, because each measurement spends quota.

| Key | Action |
|---|---|
| `R` | Refresh quota and actual usage |
| `T` | Measure throughput (small quota cost) |
| `Q` | Quit and stop the proxy |

Four blocks: the three protocol endpoints, the model list (context + measured TPS), the three quota windows (used / left / progress / reset time), and runtime status. TPS turns green above a threshold and yellow below it; `E` means the measurement failed.

Data sources: the model list and context windows come from upstream `/provider/v1/models`; window caps and usage come from `/alpha/billing/credits` (caps are server-supplied, never hardcoded); plan names and monthly totals map from `planId`.

## Configuration

`config.json`, copied from `config.example.json` and already in `.gitignore`.

| Field | Meaning |
|---|---|
| `Port` / `HostAddress` | Main proxy listener, defaults `8787` / loopback only |
| `Responses.Enabled` / `Port` | Responses adapter, enabled by default on `8788` |
| `AuthFile` | Credential path; environment variables supported |
| `Upstream.*` | Upstream endpoints; change these to target a different service |
| `Panel.ModelFilter` | Model filter regex, DeepSeek only by default |
| `Panel.SpeedTestModels` | Benchmark scope; empty means all |
| `PlanCredits` | Monthly credit total per plan (the server does not provide it) |

## Security

Listens on `127.0.0.1` only — do not change it to `0.0.0.0`. Do not share the key: upstream binds a device fingerprint to each key, and concurrent use from multiple machines is the most likely trigger for abuse controls. Credentials are read from the `auth.json` the CLI maintains; nothing is uploaded or cached.

This project modifies files inside `node_modules` belonging to `commandcode-api-proxy` (MIT, by [thaolaptrinh](https://github.com/thaolaptrinh/commandcode-api-proxy)) in order to align protocol behaviour; modified files remain the original author's. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

You accept the risk of account restrictions or plan termination.

## Troubleshooting

| Symptom | Cause |
|---|---|
| TPS shows `-` | Not measured yet; press `T` |
| TPS shows `E` | Measurement failed, usually the model is not in the plan |
| No reasoning content | Request omitted `reasoning_effort`, or set it to `none` |
| 401 | API key is something other than `proxy-managed` |
| 403 / model not recognized | Wrong model name, or not included in the plan |
| Behaviour changed after `npm install` | Patches were overwritten; re-run `.\scripts\install.ps1` |
| Port already in use | The launcher takes over its own stale instance; if another program owns it, pass `-Port` |

## Uninstall

```powershell
.\scripts\stop-proxy.ps1
.\scripts\make-shortcut.ps1 -Remove
```

Then delete the project directory. No registry entries, no system service, no PATH changes.

## License

[MIT](LICENSE)
