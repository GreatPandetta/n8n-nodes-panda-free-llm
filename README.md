# n8n-nodes-panda-free-llm

An [n8n](https://n8n.io) community node that sends a prompt to **multiple free LLM providers with automatic failover**. If the first provider is rate-limited, out of daily quota, busy, times out, or returns an empty answer, the node automatically tries the next one — and so on — until one succeeds.

Because every provider here exposes an **OpenAI-compatible** `/chat/completions` endpoint, the node uses a single request shape for all of them.

Supported free providers: **Groq, Cerebras, Google Gemini (AI Studio), OpenRouter, Mistral.**

## How it works

You give the node a fixed **System Prompt** and a per-run **User Prompt**. It walks your provider list top-to-bottom and returns the first successful reply, plus an `attempts` log showing what happened with each provider.

```
output    → the model's text answer
provider  → which provider answered
model     → which model answered
usage     → token usage (if the provider returns it)
attempts  → per-provider log (great for debugging quotas)
```

## Installation (self-hosted)

1. In n8n, go to **Settings → Community Nodes → Install**.
2. Enter the package name: `n8n-nodes-panda-free-llm`
3. Confirm, and the **Panda Free LLM** node appears in the nodes panel.

> Unverified community nodes run on self-hosted n8n. They are not available on n8n Cloud unless verified by n8n.

## Credentials

Create one **Panda Free LLM API** credential and paste in only the keys you have (blank providers are skipped automatically):

| Field | Get a free key at |
|-------|-------------------|
| Groq API Key | https://console.groq.com/keys |
| Cerebras API Key | https://cloud.cerebras.ai |
| Google AI Studio (Gemini) API Key | https://aistudio.google.com/apikey |
| OpenRouter API Key | https://openrouter.ai/keys |
| Mistral API Key | https://console.mistral.ai/api-keys |

## Usage

- **System Prompt** — your fixed instructions (set once).
- **User Prompt** — defaults to `={{ $json.text }}`. Map it to whatever field carries your input, e.g. `={{ $json.message }}`.
- **Response Format** — `Text` (plain text) or `JSON`. In JSON mode the node sends `response_format: { type: "json_object" }`, nudges the prompt to return JSON, and also returns the parsed object in `outputParsed` (handy for feeding straight into a database).
- **Provider** — the provider to try first.
- **Model** — a live dropdown of models **for the selected provider** (reopen it after changing the provider to refresh). OpenRouter is filtered to `:free` models. Leave blank to use the provider's default.
- **Enable Failover** + **Fallback Providers (in order)** — if the primary provider fails (rate limit, quota, busy, timeout, empty), the node tries each fallback in order using that provider's default model. The primary is skipped automatically if it also appears in the fallback list.
- **Options** — Max Tokens, Temperature, Timeout (ms), and "Throw If All Providers Fail" (turn off to output `success:false` instead of erroring).

Output fields: `output` (text), `provider`, `model`, `usage`, `attempts`, and — in JSON mode — `outputParsed`.

> JSON mode relies on each provider's OpenAI-compatible JSON support, which varies by model. If a model doesn't honor it, the prompt instruction still pushes it toward JSON, and a provider that rejects `response_format` simply fails over to the next.

## Publishing (for the author)

```bash
npm install
npm run build      # tsc + copies the icon into dist/
npm publish        # publishes the dist/ folder (see "files" in package.json)
```

Update `author`, `repository`, and `homepage` in `package.json` first.

## License

[MIT](LICENSE)
