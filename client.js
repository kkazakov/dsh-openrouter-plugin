/**
 * Client half of the OpenRouter balance bundle.
 *
 * Two registrations, both fed by the Host's same-origin route (the browser
 * cannot call OpenRouter with the key directly):
 *  - `conversation.composer.dock`: the ambient balance readout under the composer.
 *  - `settings.section`: the OpenRouter balance page with the full reading.
 *
 * The composer readout shows the **remaining** credit — this is a wallet, not a
 * quota, so the number counts down as credit is spent.
 *
 * Plain React only: no Harness Client package is imported, so nothing here can
 * break when those packages change.
 */
window.__ModuleLoader__.load({
  id: '@wasp/dsh-openrouter-balance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Client locale namespace and host route, both owned by this bundle. */
    const NS = 'openrouter-balance';
    const ENDPOINT = '/openrouter-balance/balance.json';
    /** Poll cadence. Each poll forces the Host to re-read upstream. */
    const POLL_MS = 60000;
    /** Age past which the reading is called out as lagging, so staleness is visible. */
    const LAG_MS = 180000;
    /** Remaining balance at or below which the readout turns amber / red. */
    const LOW_AMOUNT = 2;
    const CRITICAL_AMOUNT = 0.5;
    /** OpenRouter bills in USD only; the symbol is nicer than the code in the strip. */
    const CURRENCY_SYMBOL = { USD: '$' };

    /** English copy. */
    const en = {
      title: 'OpenRouter balance',
      description:
        'Remaining OpenRouter credit: purchased credit minus lifetime usage, plus this key’s spend.',
      refresh: 'Refresh',
      loading: 'Loading balance…',
      unavailable: 'Balance unavailable',
      remaining: 'Remaining',
      account: 'Account credit',
      purchased: 'Purchased',
      spent: 'Spent',
      updated: 'Updated',
      credential: 'Credential',
      endpoint: 'Endpoint',
      stale: 'Showing the last good reading; the latest refresh failed.',
      behind: 'behind',
      lastError: 'Last error',
      hint: 'The reading uses OPENROUTER_API_KEY from the Harness credential store; it needs no browser sign-in.',
      signIn: 'Check OPENROUTER_API_KEY in the Harness credentials.',
      never: 'never',
      keySection: 'This key',
      keyTotal: 'Lifetime usage',
      today: 'Today',
      thisWeek: 'This week',
      thisMonth: 'This month',
      keyLimit: 'Key limit',
      limitRemaining: 'Limit remaining',
      freeTier: 'Free tier',
      yes: 'yes',
      no: 'no',
      keyLimitBasis: 'key limit remaining',
    };

    /** Bulgarian copy, matching the deployment language. */
    const bg = {
      title: 'Баланс в OpenRouter',
      description:
        'Оставащ кредит в OpenRouter: закупен кредит минус общото потребление, плюс разходите на този ключ.',
      refresh: 'Обнови',
      loading: 'Зареждане на баланса…',
      unavailable: 'Балансът не е наличен',
      remaining: 'Остатък',
      account: 'Кредит по сметката',
      purchased: 'Закупено',
      spent: 'Похарчено',
      updated: 'Обновено',
      credential: 'Идентификационни данни',
      endpoint: 'Адрес',
      stale: 'Показани са последните валидни данни; последното обновяване се провали.',
      behind: 'закъснение',
      lastError: 'Последна грешка',
      hint: 'Данните идват от OPENROUTER_API_KEY в хранилището за идентификационни данни на Harness; не е нужно влизане в браузър.',
      signIn: 'Проверете OPENROUTER_API_KEY в идентификационните данни на Harness.',
      never: 'никога',
      keySection: 'Този ключ',
      keyTotal: 'Общо потребление',
      today: 'Днес',
      thisWeek: 'Тази седмица',
      thisMonth: 'Този месец',
      keyLimit: 'Лимит на ключа',
      limitRemaining: 'Оставащ лимит',
      freeTier: 'Безплатен план',
      yes: 'да',
      no: 'не',
      keyLimitBasis: 'оставащ лимит на ключа',
    };

    /** Active translator: the Client locale service replaces this during apply. */
    let t = (key) => en[key] ?? key;
    /** The client root context, captured during apply for lazy service lookup. */
    let rootCtx = null;

    /** Component-local styles, removed with the component that renders them. */
    function Styles() {
      return h('style', {
        dangerouslySetInnerHTML: {
          __html: `
.orb-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 2px 2px 0; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-secondary); }
.orb-item { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.orb-amount { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--dsw-alias-label-primary); }
.orb-amount-ok { color: var(--dsw-alias-state-success-primary); }
.orb-amount-low { color: var(--dsw-alias-state-warn-primary); }
.orb-amount-critical { color: var(--dsw-alias-state-error-primary); }
.orb-error { color: var(--dsw-alias-state-error-primary); }
.orb-age { color: var(--dsw-alias-state-warn-primary); white-space: nowrap; }
.orb-page { display: flex; flex-direction: column; gap: 16px; padding: 4px 2px; color: var(--dsw-alias-label-primary); }
.orb-page-title { font-size: 15px; font-weight: 600; }
.orb-page-description { font-size: 12px; color: var(--dsw-alias-label-secondary); max-width: 60ch; }
.orb-hero { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.orb-hero-amount { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
.orb-hero-caption { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.orb-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.orb-row { display: grid; grid-template-columns: minmax(140px, 1fr) 1fr; gap: 12px; align-items: center; padding: 10px 12px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 12px; }
.orb-row:first-child { border-top: 0; }
.orb-row-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.orb-value { font-variant-numeric: tabular-nums; }
.orb-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
.orb-meta code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-primary); }
.orb-actions { display: flex; align-items: center; gap: 10px; }
.orb-button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.orb-button:disabled { opacity: 0.6; cursor: default; }
.orb-notice { font-size: 12px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
.orb-notice-warn { color: var(--dsw-alias-state-warn-primary); }
.orb-notice-error { color: var(--dsw-alias-state-error-primary); }
.orb-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); max-width: 70ch; }
`,
        },
      });
    }

    /**
     * Render a preserved amount string in whole cents.
     * @param amount - the raw amount string.
     * @returns a two-decimal string, or an em dash when unusable.
     */
    function cents(amount) {
      if (typeof amount !== 'string' || amount === '') return '–';
      const value = Number(amount);
      if (!Number.isFinite(value)) return amount;
      return value.toFixed(2);
    }

    /**
     * Render an amount with its currency: `$10.45` for USD, `EUR 3.00` otherwise.
     * @param currency - the ISO code from the payload.
     * @param amount - the raw amount string.
     * @returns the display string.
     */
    function money(currency, amount) {
      const text = cents(amount);
      const symbol = CURRENCY_SYMBOL[currency];
      return symbol === undefined ? `${currency} ${text}` : `${symbol}${text}`;
    }

    /**
     * Classify the remaining balance for colour and the low-credit flag.
     * @param amount - the raw balance string.
     * @returns the severity level.
     */
    function levelOf(amount) {
      const value = Number(amount);
      if (!Number.isFinite(value)) return 'ok';
      if (value <= CRITICAL_AMOUNT) return 'critical';
      if (value <= LOW_AMOUNT) return 'low';
      return 'ok';
    }

    /** Severity to the amount's colour class. */
    const LEVEL_CLASS = {
      ok: 'orb-amount orb-amount-ok',
      low: 'orb-amount orb-amount-low',
      critical: 'orb-amount orb-amount-critical',
    };

    /** Severity to the hero amount's colour-only class. */
    const LEVEL_COLOR = {
      ok: 'orb-amount-ok',
      low: 'orb-amount-low',
      critical: 'orb-amount-critical',
    };

    /**
     * Subscribe to the Host's balance route.
     * @returns the current state plus a manual refresh trigger.
     */
    function useBalance() {
      const [state, setState] = React.useState({ status: 'loading', payload: null, pending: false });
      const [, setTick] = React.useState(0);
      const load = React.useCallback(async (force) => {
        setState((current) => ({ ...current, pending: true }));
        try {
          const response = await fetch(force === true ? `${ENDPOINT}?refresh=1` : ENDPOINT, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          });
          const payload = await response.json();
          setState({ status: 'ready', payload, pending: false });
        } catch (error) {
          setState((current) => ({
            status: current.payload === null ? 'error' : 'ready',
            payload: current.payload,
            error: error instanceof Error ? error.message : String(error),
            pending: false,
          }));
        }
      }, []);
      React.useEffect(() => {
        void load(true);
        const timer = setInterval(() => void load(true), POLL_MS);
        return () => clearInterval(timer);
      }, [load]);
      // Re-render on a slow tick so the "behind" age stays honest between polls.
      React.useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), 30000);
        return () => clearInterval(timer);
      }, []);
      return { state, refresh: () => void load(true) };
    }

    /**
     * Read the provider of the model currently selected for this session, so the
     * readout can follow the active model rather than always being visible.
     * @param sessionId - the slot's session id.
     * @returns the provider id, or null when none is selected or unknown.
     */
    function useSelectedProvider(sessionId) {
      const [provider, setProvider] = React.useState(null);
      React.useEffect(() => {
        const dirs = rootCtx === null ? null : (rootCtx.get('modelDirectories') ?? null);
        if (sessionId === null || sessionId === undefined || dirs === null) {
          setProvider(null);
          return;
        }
        let directory;
        try {
          directory = dirs.directoryFor(sessionId);
        } catch {
          setProvider(null);
          return;
        }
        const apply = () => {
          const snapshot = directory.store.getSnapshot();
          const current = snapshot !== null && typeof snapshot === 'object' ? snapshot.current : null;
          setProvider(
            current !== null && typeof current === 'object' && typeof current.provider === 'string'
              ? current.provider
              : null,
          );
        };
        apply();
        const unsubscribe = directory.store.subscribe(apply);
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [sessionId]);
      return provider;
    }

    /**
     * The ambient readout under the composer: the remaining credit, in one line.
     * @param props - the slot props, including the session id.
     * @returns the readout, a compact failure line, or null when hidden.
     */
    function BalanceStrip(props) {
      const { state } = useBalance();
      const provider = useSelectedProvider(props.sessionId);
      const payload = state.payload;
      const showForAll = payload !== null && payload.showForAllProviders === true;
      const match =
        payload !== null && typeof payload.providerMatch === 'string' && payload.providerMatch !== ''
          ? payload.providerMatch
          : 'openrouter';
      const wanted =
        showForAll ||
        (provider !== null &&
          provider !== undefined &&
          provider.toLowerCase().indexOf(match.toLowerCase()) !== -1);
      if (!wanted) return null;
      if (payload === null || payload.balance === null) {
        if (state.status === 'loading') return h('div', { className: 'orb-strip' }, t('loading'));
        return h(
          'div',
          { className: 'orb-strip orb-error', title: state.error ?? payload?.error ?? '' },
          t('unavailable'),
        );
      }
      const balance = payload.balance;
      const level = levelOf(balance.amount);
      const age = typeof payload.fetchedAt === 'string' ? Date.now() - Date.parse(payload.fetchedAt) : null;
      const lag = age !== null && Number.isFinite(age) && age > LAG_MS ? age : null;
      // The strip shows one thing only: the remaining balance, in whole cents.
      const text = `${t('remaining')}: ${money(balance.currency, balance.amount)}`;
      return h(
        'div',
        { className: 'orb-strip', 'data-component': 'openrouter-balance-strip' },
        h(Styles, null),
        h(
          'span',
          { className: 'orb-item', title: text },
          h('span', { className: LEVEL_CLASS[level] ?? LEVEL_CLASS.ok }, text),
        ),
        payload.stale === true ? h('span', { className: 'orb-error' }, t('stale')) : null,
        lag === null ? null : h('span', { className: 'orb-age' }, `${t('behind')} ${Math.round(lag / 60000)}m`),
      );
    }

    /**
     * The OpenRouter balance settings page.
     * @returns the full reading with its provenance and a manual refresh.
     */
    function BalanceSettings() {
      const { state, refresh } = useBalance();
      const payload = state.payload;
      const key = payload !== null && payload.key !== null && typeof payload.key === 'object' ? payload.key : null;
      const updated = payload?.fetchedAt == null ? t('never') : new Date(payload.fetchedAt).toLocaleString();
      const primary = payload?.balance ?? null;
      const errorText = state.error ?? payload?.error ?? null;
      const rejected = typeof errorText === 'string' && errorText.indexOf('key was rejected') !== -1;
      const warnings = payload !== null && Array.isArray(payload.warnings) ? payload.warnings : [];

      /**
       * One card of label/value rows.
       * @param heading - the card title.
       * @param rows - `[label, value]` pairs; a null value hides the row.
       * @returns the card, or null when it has no rows.
       */
      const card = (heading, rows) => {
        const shown = rows.filter((row) => row[1] !== null && row[1] !== undefined);
        if (shown.length === 0) return null;
        return h(
          'div',
          { className: 'orb-card' },
          h('div', { className: 'orb-row orb-row-head' }, h('span', null, heading), h('span', null, '')),
          ...shown.map(([label, value], index) =>
            h(
              'div',
              { className: 'orb-row', key: `${heading}-${index}` },
              h('span', null, label),
              h('span', { className: 'orb-value' }, value),
            ),
          ),
        );
      };

      return h(
        'div',
        { className: 'orb-page', 'data-component': 'openrouter-balance-settings' },
        h(Styles, null),
        h('div', { className: 'orb-page-title' }, t('title')),
        h('div', { className: 'orb-page-description' }, t('description')),
        errorText === null
          ? null
          : h(
              'div',
              { className: `orb-notice ${rejected ? 'orb-notice-error' : 'orb-notice-warn'}` },
              `${t('lastError')}: ${errorText}`,
            ),
        payload?.stale === true ? h('div', { className: 'orb-notice orb-notice-warn' }, t('stale')) : null,
        ...warnings.map((warning, index) =>
          h('div', { className: 'orb-notice orb-notice-warn', key: `warn-${index}` }, warning),
        ),
        primary === null
          ? h('div', { className: 'orb-hint' }, state.status === 'loading' ? t('loading') : t('unavailable'))
          : h(
              'div',
              { className: 'orb-hero' },
              h(
                'span',
                { className: `orb-hero-amount ${LEVEL_COLOR[levelOf(primary.amount)] ?? ''}` },
                money(primary.currency, primary.amount),
              ),
              h(
                'span',
                { className: 'orb-hero-caption' },
                `${t('remaining')} · ${primary.basis === 'key limit' ? t('keyLimitBasis') : t('account')}`,
              ),
            ),
        card(t('account'), [
          [t('purchased'), payload?.totalCredits == null ? null : money('USD', payload.totalCredits)],
          [t('spent'), payload?.totalUsage == null ? null : money('USD', payload.totalUsage)],
        ]),
        card(t('keySection'), [
          [t('keyTotal'), key?.usage == null ? null : money('USD', key.usage)],
          [t('today'), key?.usageDaily == null ? null : money('USD', key.usageDaily)],
          [t('thisWeek'), key?.usageWeekly == null ? null : money('USD', key.usageWeekly)],
          [t('thisMonth'), key?.usageMonthly == null ? null : money('USD', key.usageMonthly)],
          [t('keyLimit'), key?.limit == null ? null : money('USD', key.limit)],
          [t('limitRemaining'), key?.limitRemaining == null ? null : money('USD', key.limitRemaining)],
          [t('freeTier'), key === null ? null : key.isFreeTier === true ? t('yes') : t('no')],
        ]),
        h(
          'div',
          { className: 'orb-meta' },
          h('span', null, `${t('updated')}: `, h('code', null, updated)),
          h('span', null, `${t('credential')}: `, h('code', null, payload?.credentialSource ?? '–')),
          h('span', null, `${t('endpoint')}: `, h('code', null, payload?.source ?? '–')),
        ),
        h(
          'div',
          { className: 'orb-actions' },
          h(
            'button',
            { type: 'button', className: 'orb-button', disabled: state.pending === true, onClick: refresh },
            state.pending === true ? t('loading') : t('refresh'),
          ),
        ),
        h('div', { className: 'orb-hint' }, t('hint')),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        t = ctx.locale.bind(NS);
        rootCtx = ctx;
        ctx.effect(() => {
          const disposers = [];
          const register = (locale, dict) => {
            try {
              disposers.push(ctx.locale.register(NS, locale, dict));
            } catch (error) {
              console.error(`${NS}: ${locale} dictionary not registered`, error);
            }
          };
          register('en', en);
          register('bg', bg);
          return () => {
            for (const dispose of disposers) dispose();
          };
        }, `${NS}: dictionaries`);
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: NS, order: 5 }, BalanceStrip),
        );
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: NS, order: 32, label: () => t('title') },
            BalanceSettings,
          ),
        );
      },
    };
  },
});
