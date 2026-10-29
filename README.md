# dsh-openrouter-balance

Remaining **OpenRouter credit** inside DeepSeek Harness: an ambient readout
under the composer, a settings page, and an `openrouter_balance` tool the agent
can call.

This is a **wallet**, not a quota. The number counts down as credit is spent, so
it answers "how much of my top-up is left?" — the question per-key usage meters
cannot answer on their own.

## What it gives you

| Surface | Behaviour |
|---|---|
| **Composer readout** | `Remaining: $9.89` under the composer. Polls every 60s; goes amber below `$2` and red below `$0.50`. |
| **Model-aware visibility** | Shows while the session's selected model belongs to an OpenRouter provider (`openrouter` by default). Set `showForAllProviders: true` to always show it. |
| **Settings page** | *Settings → OpenRouter balance*: the remaining amount, purchased vs. spent credit, this key's daily/weekly/monthly usage and limit, plus the credential source, endpoint, and a manual **Refresh**. |
| **`openrouter_balance` tool** | The same reading as text, so the agent can report headroom before an expensive run. |
| **No prompt notice** | Display-only by design. Nothing is injected into the model's context. |

Account totals and this key's usage are shown in **separate** cards and are never
mixed: a single key can be under its limit while the account itself is empty.

## Requirements

- DeepSeek Harness with the Web UI.
- An **OpenRouter API key** in the Harness credential store (as
  `OPENROUTER_API_KEY`) or in the environment. No browser sign-in is involved.

## How it reads the balance

Two read-only endpoints, both with `Authorization: Bearer <key>`:

```
GET https://openrouter.ai/api/v1/credits
```

```json
{ "data": { "total_credits": 170, "total_usage": 160.109211992 } }
```

```
GET https://openrouter.ai/api/v1/auth/key
```

```json
{
  "data": {
    "label": "sk-or-v1-9db...e60",
    "usage": 158.777231572,
    "usage_daily": 9.6182435,
    "usage_weekly": 9.841169342,
    "usage_monthly": 9.841169342,
    "limit": null,
    "limit_remaining": null,
    "is_free_tier": false
  }
}
```

The remaining credit is `total_credits - total_usage` — the same number the
OpenRouter console shows. The difference is rounded to six decimals to shed
binary-float noise, and everything is rounded to whole cents for display.

The endpoints fail independently: if `credits` is unavailable the reading falls
back to a hard key `limit_remaining`, and a partial failure is surfaced as a
warning rather than a blank panel. Only when neither answers does the readout
report an error.

## Install

**Web.** *Plugins* page → **Add plugin** → paste `@wasp/dsh-openrouter-balance`.

**From a checkout** (local development):

```jsonc
// ~/.dsh/profiles/<profile>/package.json
"dependencies": { "@wasp/dsh-openrouter-balance": "link:/path/to/openrouter-balance-plugin" },
"dsh": { "profile": { "bundles": [ /* … */ "@wasp/dsh-openrouter-balance" ] } }
```

Then apply the bundle's patch row to the profile's `cordis.yml` and restart the
Host. The Host serves the reading on `/openrouter-balance/balance.json`.

Installing runs the plugin **in-process with your permissions**.

## Configuration

Overridable in your profile patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: openrouter-balance
  name: '@wasp/dsh-openrouter-balance'
  config:
    refreshSeconds: 300
    providerMatch: 'openrouter'
```

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `''` | Use this key instead of the environment or the credential store. Prefer leaving it empty. |
| `credentialsFile` | `''` | Path to the Harness credential store. Empty means `~/.dsh/.credentials.yaml`. |
| `apiOrigin` | `https://openrouter.ai` | The API origin. |
| `refreshSeconds` | `300` | How often the Host re-reads the balance (minimum 30). |
| `providerMatch` | `'openrouter'` | The readout shows when the selected provider id contains this substring. |
| `showForAllProviders` | `false` | Show the readout regardless of the selected provider. |

The key is resolved in this order: `apiKey` → `OPENROUTER_API_KEY` in the
environment → `OPENROUTER_API_KEY` in the credential store's `refs:` map.

## Privacy

- The key is read from disk on each refresh and sent **only** to
  `openrouter.ai`, as a bearer token. It is never logged, cached to disk, or sent
  anywhere else.
- The local route exposes amounts, the key's *label* (`sk-or-v1-9db...e60`, as
  OpenRouter itself returns it), and the *path* the key came from — never the key
  itself.
- No telemetry, no analytics, no third-party requests.

## Failure behaviour

- A rejected key (HTTP 401) is reported as *"the OpenRouter API key was
  rejected"*, never as a zero balance.
- A transport failure keeps the last good reading and marks it stale, so a blip
  does not blank the readout.
- A malformed amount is rejected rather than coerced to `0`.

## Development

The Host half can be exercised against the live endpoint without installing
anything:

```bash
node test-host.mjs
```

It drives `apply()` with a fake Cordis context and prints the tool output, the
route response, the method guard, and the failure path for a bad key.

## License

MIT — see [LICENSE](LICENSE).
