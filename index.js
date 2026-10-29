/**
 * Host half of the OpenRouter balance bundle.
 *
 * It reads the OpenRouter **account credit** — purchased credit minus lifetime
 * usage — and publishes it three ways: an `openrouter_balance` agent tool, a
 * same-origin JSON route the Client half polls for its composer strip and
 * settings page, and nothing else (no prompt notice; this bundle is
 * display-only by design).
 *
 * ## Which credential
 *
 * OpenRouter is a plain bearer-token API, so this is simpler than the DeepSeek
 * sibling: the key sits in the Harness credential store's `refs:` map under
 * `OPENROUTER_API_KEY` (or in the environment), and it is sent as
 * `Authorization: Bearer <key>` to two read-only endpoints:
 *
 *   GET https://openrouter.ai/api/v1/credits   -> total_credits, total_usage
 *   GET https://openrouter.ai/api/v1/auth/key  -> per-key usage, limits, tier
 *
 * The first is the number the OpenRouter console shows as the remaining credit
 * balance; the second adds this key's own daily/weekly/monthly spend and any
 * hard key limit.
 *
 * ## Notes
 *
 * - `total_credits` and `total_usage` are account-wide, summed across every key.
 *   `auth/key`'s `usage` is this key only, so the two are reported separately and
 *   never mixed: a single key can be under its limit while the account is
 *   empty.
 * - Amounts arrive as JSON numbers. The original numeric value is preserved as a
 *   string and only rounded for display; a malformed value is rejected rather
 *   than silently coerced to zero.
 * - The derived remainder is rounded to six decimals to shed binary-float noise
 *   (`10.450210508000005` -> `10.450210`).
 * - A credential rejection (HTTP 401) means the key is wrong or revoked; it is
 *   reported as such instead of being shown as a zero balance.
 *
 * No imports from Harness packages: the definition objects below are the exact
 * shapes `ctx.tools.register` and `ctx.webServer.register` consume.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Account credit endpoint: purchased credit and lifetime spend. */
const CREDITS_PATH = '/api/v1/credits';
/** Per-key endpoint: usage breakdown, key limit, free-tier flag. */
const KEY_PATH = '/api/v1/auth/key';
/** Default API origin; overridable for loopback development. */
const DEFAULT_API_ORIGIN = 'https://openrouter.ai';
/** Same-origin route for the Web page; outside `/plugins` so no bundle route can shadow it. */
const USAGE_PATH = '/openrouter-balance/balance.json';
/** Socket timeout for one balance request. */
const REQUEST_TIMEOUT_MS = 30000;
/** Default credential store: the Harness home. */
const DEFAULT_CREDENTIALS_FILE = join(homedir(), '.dsh/.credentials.yaml');
/** Credential-store ref holding the OpenRouter inference key. */
const REF_KEY = 'OPENROUTER_API_KEY';
/** Environment variable consulted when the credential store has no ref. */
const ENV_KEY = 'OPENROUTER_API_KEY';
/** Decimal places kept on the derived remainder. */
const REMAINDER_PRECISION = 6;

/**
 * Read the OpenRouter key out of the Harness credential store.
 *
 * The store is small, line-oriented YAML written by the Harness itself, so the
 * `refs:` map is located by key and its `OPENROUTER_API_KEY` entry read without
 * a YAML parser — which keeps this bundle dependency-free. Values that contain
 * YAML metacharacters are quoted by the writer; both forms are handled.
 *
 * @param file - absolute path of the credentials file.
 * @returns the API key.
 * @throws when the file is unreadable or carries no ref.
 */
async function readRef(file) {
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');

  /** Strip an optional matching pair of YAML quotes from a scalar. */
  const unquote = (raw) => {
    const value = raw.trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if (first === last && (first === '"' || first === "'")) return value.slice(1, -1);
    }
    return value;
  };

  // Pass 1: locate the `refs:` map and record the indentation of its block.
  let refsIndent = null;
  let refsLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === 'refs:') {
      refsIndent = line.length - line.trimStart().length;
      refsLine = index;
      break;
    }
  }
  if (refsLine === -1) {
    throw new Error(
      `no refs map in ${file}. Set OPENROUTER_API_KEY in the Harness, or set config.apiKey.`,
    );
  }

  // Pass 2: walk the map's block. Sibling keys use the same or less indentation
  // and end the search.
  for (let index = refsLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const leading = line.length - line.trimStart().length;
    if (leading <= refsIndent) break;
    const match = new RegExp(`^${REF_KEY}:\\s*(.*)$`).exec(trimmed);
    if (match === null) continue;
    const value = unquote(match[1]);
    if (value !== '') return value;
  }
  throw new Error(
    `the refs map in ${file} carries no ${REF_KEY}. Set it in the Harness, or set config.apiKey.`,
  );
}

/**
 * Resolve the key from configuration first, then the environment, then the
 * credential store.
 * @param config - resolved plugin configuration.
 * @returns the key and where it came from.
 */
async function resolveKey(config) {
  if (typeof config.apiKey === 'string' && config.apiKey !== '') {
    return { key: config.apiKey, source: 'plugin config' };
  }
  const fromEnv = process.env[ENV_KEY];
  if (typeof fromEnv === 'string' && fromEnv !== '') {
    return { key: fromEnv, source: `environment ${ENV_KEY}` };
  }
  const file = config.credentialsFile !== '' ? config.credentialsFile : DEFAULT_CREDENTIALS_FILE;
  try {
    return { key: await readRef(file), source: file };
  } catch (error) {
    throw new Error(
      `could not read ${REF_KEY} from ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Accept an amount the way OpenRouter sends it: a finite number, echoed back as
 * a string so no precision is lost on the way to display. Strings are accepted
 * too, for forward compatibility.
 * @param value - the raw amount.
 * @returns the amount as a string, or null when it is not usable.
 */
function normalizeAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
  return Number.isFinite(Number(text)) ? text : null;
}

/**
 * Subtract two preserved amount strings, shedding binary-float noise.
 * @param total - the minuend as a string.
 * @param used - the subtrahend as a string.
 * @returns the difference as a string, or null when either input is unusable.
 */
function subtract(total, used) {
  const a = Number(total);
  const b = Number(used);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return String(Number((a - b).toFixed(REMAINDER_PRECISION)));
}

/**
 * Resolve the plugin configuration against its defaults.
 * @param config - the row's config object.
 * @returns the usable configuration.
 */
function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {};
  const refreshSeconds =
    Number.isFinite(raw.refreshSeconds) && raw.refreshSeconds >= 30 ? raw.refreshSeconds : 300;
  const origin =
    typeof raw.apiOrigin === 'string' && raw.apiOrigin !== ''
      ? raw.apiOrigin.replace(/\/+$/, '')
      : DEFAULT_API_ORIGIN;
  return {
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    credentialsFile: typeof raw.credentialsFile === 'string' ? raw.credentialsFile : '',
    apiOrigin: origin,
    refreshSeconds,
    /** The provider id whose selection shows the composer strip. */
    providerMatch:
      typeof raw.providerMatch === 'string' && raw.providerMatch !== ''
        ? raw.providerMatch
        : 'openrouter',
    /** Show the strip for every provider instead of only the matched one. */
    showForAllProviders: raw.showForAllProviders === true,
  };
}

/**
 * Fetch one endpoint and decode it, turning transport and protocol failures into
 * messages a person can act on.
 * @param url - the absolute endpoint URL.
 * @param key - the OpenRouter API key.
 * @returns the decoded `data` object and the URL actually read.
 */
async function getJson(url, key) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (response.status === 401) {
    throw new Error(
      'the OpenRouter API key was rejected (HTTP 401). Check OPENROUTER_API_KEY in the Harness credentials.',
    );
  }
  if (!response.ok) {
    throw new Error(`request failed: HTTP ${response.status}${text === '' ? '' : ` ${text.slice(0, 300)}`}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`response was not JSON: ${text.slice(0, 200)}`);
  }
  const data =
    body !== null && typeof body === 'object' && body.data !== null && typeof body.data === 'object'
      ? body.data
      : body;
  if (data === null || typeof data !== 'object') {
    throw new Error('response carried no data object');
  }
  return { data, url };
}

/**
 * Normalize the `auth/key` payload into display fields.
 * @param data - the endpoint's `data` object.
 * @returns the per-key reading, or null when it carries nothing usable.
 */
function normalizeKey(data) {
  if (data === null || typeof data !== 'object') return null;
  const usage = normalizeAmount(data.usage);
  const limit = normalizeAmount(data.limit);
  const limitRemaining = normalizeAmount(data.limit_remaining);
  if (usage === null && limit === null && limitRemaining === null) return null;
  return {
    label: typeof data.label === 'string' && data.label !== '' ? data.label : null,
    usage,
    usageDaily: normalizeAmount(data.usage_daily),
    usageWeekly: normalizeAmount(data.usage_weekly),
    usageMonthly: normalizeAmount(data.usage_monthly),
    limit,
    limitRemaining,
    isFreeTier: data.is_free_tier === true,
  };
}

/**
 * Fetch and normalize the current balance from both endpoints.
 *
 * The two endpoints fail independently: the reading reports whatever arrived
 * plus a warning for whatever did not, and only fails outright when neither
 * answered.
 *
 * @param config - resolved plugin configuration.
 * @returns the balance, the account totals, the per-key reading, and warnings.
 */
async function fetchBalance(config) {
  const { key, source } = await resolveKey(config);
  const [creditsResult, keyResult] = await Promise.allSettled([
    getJson(`${config.apiOrigin}${CREDITS_PATH}`, key),
    getJson(`${config.apiOrigin}${KEY_PATH}`, key),
  ]);

  const warnings = [];
  const describe = (error) => (error instanceof Error ? error.message : String(error));

  const credits = creditsResult.status === 'fulfilled' ? creditsResult.value : null;
  const keyInfo = keyResult.status === 'fulfilled' ? keyResult.value : null;
  if (creditsResult.status === 'rejected') warnings.push(`credits endpoint: ${describe(creditsResult.reason)}`);
  if (keyResult.status === 'rejected') warnings.push(`key endpoint: ${describe(keyResult.reason)}`);

  if (credits === null && keyInfo === null) {
    throw new Error(warnings.join('; '));
  }

  const totalCredits = credits === null ? null : normalizeAmount(credits.data.total_credits);
  const totalUsage = credits === null ? null : normalizeAmount(credits.data.total_usage);
  const perKey = keyInfo === null ? null : normalizeKey(keyInfo.data);

  // The account remainder is the console's number: purchased minus spent.
  let amount = totalCredits !== null && totalUsage !== null ? subtract(totalCredits, totalUsage) : null;
  // Without account totals, a hard key limit is the next-best statement of what
  // is left to spend on this key.
  let basis = amount === null ? null : 'account';
  if (amount === null && perKey !== null && perKey.limitRemaining !== null) {
    amount = perKey.limitRemaining;
    basis = 'key limit';
  }
  if (amount === null) {
    throw new Error(
      warnings.length > 0
        ? warnings.join('; ')
        : 'the response carried neither account credit nor a key limit',
    );
  }

  return {
    balance: { currency: 'USD', amount, basis },
    totalCredits,
    totalUsage,
    key: perKey,
    warnings,
    credentialSource: source,
    source: credits !== null ? credits.url : keyInfo.url,
  };
}

/**
 * Format one amount for display, trimming excess precision while keeping
 * sub-cent accuracy (a remainder of 10.450210 reads as 10.4502).
 * @param amount - the preserved amount string.
 * @returns a compact display string.
 */
function trimAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  const fixed = value.toFixed(4);
  return fixed.replace(/\.?0+$/, '') === '' ? '0' : fixed.replace(/\.?0+$/, '');
}

/**
 * Required service: the tool registry. `webServer` is optional and is looked up
 * lazily with `ctx.inject`, so the plugin still works without one.
 *
 * This export is load-bearing: without it Cordis activates the plugin
 * immediately, `ctx.tools` is undefined when `apply` runs, and the tool
 * registration below throws — which silently drops the tool *and* the route
 * registered after it.
 */
export const inject = ['tools'];

/**
 * Register the OpenRouter balance integration.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the row's config object.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  /** Last successful reading; kept across failed refreshes so a blip never blanks the UI. */
  const state = { reading: null, fetchedAt: null, error: null, credentialSource: null, url: null };
  let inFlight = null;

  /**
   * Refresh the cached reading, collapsing concurrent callers onto one request.
   * @param force - fetch even when the cached reading is still fresh.
   * @returns the settled state.
   */
  const refresh = (force) => {
    const fresh =
      state.fetchedAt !== null && Date.now() - state.fetchedAt < config.refreshSeconds * 1000;
    if (inFlight !== null) return inFlight;
    if (fresh && force !== true) return Promise.resolve(state);
    inFlight = (async () => {
      try {
        const reading = await fetchBalance(config);
        state.reading = reading;
        state.fetchedAt = Date.now();
        state.credentialSource = reading.credentialSource;
        state.url = reading.source;
        state.error = null;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        inFlight = null;
      }
      return state;
    })();
    return inFlight;
  };

  /**
   * Build the payload shared by the route and the tool.
   * @returns a JSON-safe snapshot.
   */
  const payload = () => {
    const reading = state.reading;
    return {
      ok: reading !== null && state.error === null,
      stale: reading !== null && state.error !== null,
      fetchedAt: state.fetchedAt === null ? null : new Date(state.fetchedAt).toISOString(),
      credentialSource: state.credentialSource,
      source: state.url ?? `${config.apiOrigin}${CREDITS_PATH}`,
      refreshSeconds: config.refreshSeconds,
      providerMatch: config.providerMatch,
      showForAllProviders: config.showForAllProviders,
      balance: reading === null ? null : reading.balance,
      totalCredits: reading === null ? null : reading.totalCredits,
      totalUsage: reading === null ? null : reading.totalUsage,
      key: reading === null ? null : reading.key,
      warnings: reading === null ? [] : reading.warnings,
      error: state.error,
    };
  };

  /**
   * Render the reading as the compact text the agent reads.
   * @param snapshot - the payload.
   * @returns the balance line, spend totals, and any failure.
   */
  const format = (snapshot) => {
    const lines = [];
    const money = (amount) => `USD ${trimAmount(amount)}`;
    if (snapshot.ok !== true && snapshot.stale !== true) {
      lines.push('OpenRouter balance: no reading yet.');
    } else {
      const balance = snapshot.balance;
      lines.push(
        `OpenRouter balance: ${balance === null ? 'n/a' : money(balance.amount)}` +
          (balance === null ? '' : balance.basis === 'key limit' ? ' (key limit remaining)' : ' (remaining credit)'),
      );
      if (snapshot.totalCredits !== null && snapshot.totalUsage !== null) {
        lines.push(
          `Total spent: ${money(snapshot.totalUsage)} of ${money(snapshot.totalCredits)} purchased`,
        );
      }
      const key = snapshot.key;
      if (key !== null) {
        const meters = [
          key.usageDaily === null ? null : `today ${money(key.usageDaily)}`,
          key.usageWeekly === null ? null : `this week ${money(key.usageWeekly)}`,
          key.usageMonthly === null ? null : `this month ${money(key.usageMonthly)}`,
        ].filter((entry) => entry !== null);
        if (meters.length > 0) lines.push(`This key: ${meters.join(', ')}`);
        if (key.limit !== null) {
          lines.push(
            `Key limit: ${money(key.limit)}${key.limitRemaining === null ? '' : `, ${money(key.limitRemaining)} left`}`,
          );
        }
      }
    }
    if (snapshot.fetchedAt !== null) lines.push(`fetched ${snapshot.fetchedAt} from ${snapshot.source}`);
    for (const warning of snapshot.warnings) lines.push(`warning: ${warning}`);
    if (snapshot.error !== null) lines.push(`last refresh failed: ${snapshot.error}`);
    return lines.join('\n');
  };

  // Poll in the background so the strip and the tool stay current.
  ctx.effect(() => {
    void refresh(false);
    const timer = setInterval(() => void refresh(false), config.refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, 'openrouter-balance: polling');

  // Agent tool: read the balance on demand.
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'openrouter_balance',
        description:
          'Read the remaining OpenRouter account credit: purchased credit minus lifetime usage, plus this key\'s daily/weekly/monthly spend and any key limit. Report it before starting an expensive run when the user asks how much credit is left.',
        parameters: {
          type: 'object',
          properties: {
            refresh: {
              type: 'boolean',
              description:
                'Force a fresh reading instead of the cached one (the cache lives for the configured refresh interval).',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [
            { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
          ],
        },
        async execute(args) {
          const requested = args !== null && typeof args === 'object' && args.refresh === true;
          await refresh(requested);
          return format(payload());
        },
        isConcurrencySafe: () => true,
      }),
    'openrouter-balance: tool',
  );

  // Same-origin route for the Web page. The browser cannot call OpenRouter with
  // the key itself, so the Host serves the reading on its own origin.
  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed');
        return;
      }
      const url = new URL(req.url ?? USAGE_PATH, 'http://localhost');
      await refresh(url.searchParams.get('refresh') === '1');
      const body = JSON.stringify(payload(), null, 2);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: USAGE_PATH, handler }),
      'openrouter-balance: balance route',
    );
  });
}
