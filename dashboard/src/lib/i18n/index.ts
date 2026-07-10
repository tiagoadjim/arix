import { es } from './es';
import { en } from './en';

export type Locale = 'es' | 'en';

/** Exactly 7 entries, index 0 = Sunday … index 6 = Saturday. */
export type Weekday7<T> = readonly [T, T, T, T, T, T, T];

/** Typed nested dictionary shape — every locale file must satisfy this exactly. */
export interface Dictionary {
  /**
   * Stable, snake_case API error codes (see server/src/api/server.ts's
   * `{ error: '<code>' }` responses) → localized message. Looked up via
   * lib/api.ts's apiErrorMessage(); an unrecognized code falls back to the
   * raw code string, so this map does not need to be exhaustive to be safe.
   */
  errors: Record<string, string>;
  common: {
    save: string;
    saving: string;
    saved: string;
    cancel: string;
    retry: string;
    loading: string;
    error: string;
    confirm: string;
    delete: string;
    deleting: string;
    next: string;
    back: string;
    skip: string;
    finish: string;
    yes: string;
    no: string;
    close: string;
    refresh: string;
    testConnection: string;
    testing: string;
    advanced: string;
    envLockedBadge: string;
    noChanges: string;
  };
  login: {
    title: string;
    subtitle: string;
    emailLabel: string;
    passwordLabel: string;
    submit: string;
    submitting: string;
    errorGeneric: string;
  };
  sidebar: {
    filterAll: string;
    filterHuman: string;
    filterUnread: string;
    /** e.g. "3 unread" / "3 sin leer" — used as a compact suffix, not a full sentence. */
    unread: string;
    emptyList: string;
    fetchError: string;
    muteOnTooltip: string;
    muteOffTooltip: string;
    muteOnAria: string;
    muteOffAria: string;
    settingsNav: string;
    signOut: string;
    modeHuman: string;
    themeToLight: string;
    themeToDark: string;
  };
  panelHome: {
    hint: string;
  };
  time: {
    now: string;
    /** Full weekday names, index 0 = Sunday … 6 = Saturday (mirrors server/src/agent/hours.ts). */
    weekdays: Weekday7<string>;
  };
  conversation: {
    notFound: string;
    loadingConversation: string;
    modeBot: string;
    modeHuman: string;
    takeChat: string;
    returnToBot: string;
    refreshAria: string;
    botHint: string;
    messagesLabel: string;
    composerPlaceholder: string;
    send: string;
    sending: string;
    sendFailed: string;
    messageFailedTag: string;
    mediaAlt: string;
    sender: { customer: string; agent: string; human: string; system: string };
    media: { audio: string; video: string; sticker: string; document: string; image: string };
    ordersTitle: string;
    ordersEmpty: string;
    ordersLoading: string;
    ordersError: string;
    ordersRefreshAria: string;
    orderStatuses: {
      pending: string;
      processing: string;
      'en-camino': string;
      'on-hold': string;
      completed: string;
      cancelled: string;
      refunded: string;
      failed: string;
    };
    changeStatusButton: string;
    statusChanged: string;
    statusChangeFailed: string;
    dispatchButton: string;
    dispatchDialogTitle: string;
    dispatchDialogDescription: string;
    trackingUrlLabel: string;
    trackingUrlPlaceholder: string;
    deliveryCodeLabel: string;
    deliveryCodePlaceholder: string;
    dispatchSubmit: string;
    dispatchSubmitting: string;
    dispatchSent: string;
    dispatchSentNoStatus: string;
    dispatchFailed: string;
    dispatchMissingFields: string;
    receiptsTitle: string;
    receiptsEmpty: string;
    receiptOrderLabel: string;
    receiptAmountLabel: string;
    receiptTotalLabel: string;
    receiptResultLabel: string;
    receiptImageAlt: string;
    matchStatus: { match: string; mismatch: string; unreadable: string; pending: string };
  };
  settings: {
    pageTitle: string;
    pageDescription: string;
    tabProvider: string;
    tabStore: string;
    tabBusiness: string;
    tabSkills: string;
    tabMcp: string;
    tabWhatsapp: string;
    tabStaff: string;
    saveButton: string;
    savedToast: string;
    setByEnvBadge: string;
    secretSetPlaceholder: string;
    secretUnsetPlaceholder: string;
    showSecretAria: string;
    hideSecretAria: string;
    provider: {
      providerLabel: string;
      docsLinkLabel: string;
      defaultModelHint: string;
      apiKeyLabel: string;
      modelLabel: string;
      modelPlaceholderHint: string;
      baseUrlLabel: string;
      baseUrlHint: string;
      visionFallbackLabel: string;
      visionFallbackAskDetails: string;
      visionFallbackHandoff: string;
      advancedTitle: string;
      reasoningSplitLabel: string;
      reasoningSplitHint: string;
      thinkingDisabledLabel: string;
      thinkingDisabledHint: string;
      testSuccessToast: string;
      visionYes: string;
      visionNo: string;
      testErrorTitle: string;
    };
    store: {
      urlLabel: string;
      urlPlaceholder: string;
      consumerKeyLabel: string;
      consumerSecretLabel: string;
      frontUrlLabel: string;
      frontUrlHint: string;
      currencyLabel: string;
      statusAfterPaymentLabel: string;
      statusAfterDispatchLabel: string;
      statusAfterDispatchHint: string;
      productLinkTemplateLabel: string;
      productLinkTemplateHint: string;
      toleranceLabel: string;
      toleranceHint: string;
      testSuccessToast: string;
      testSuccessWithProductToast: string;
      testErrorTitle: string;
    };
    business: {
      businessNameLabel: string;
      agentNameLabel: string;
      agentLanguageLabel: string;
      uiLanguageLabel: string;
      uiLanguageHint: string;
      discloseBotLabel: string;
      discloseBotHint: string;
      timezoneLabel: string;
      timezoneHint: string;
      hoursTitle: string;
      hoursHint: string;
      hoursClosedLabel: string;
      hoursOpenLabel: string;
      hoursCloseLabel: string;
      hoursNextDayLabel: string;
      infoPaymentLabel: string;
      infoPaymentHint: string;
      infoShippingLabel: string;
      infoShippingHint: string;
      infoGeneralLabel: string;
      infoGeneralHint: string;
      complianceLabel: string;
      complianceHint: string;
      dispatchTemplateLabel: string;
      dispatchTemplateHint: string;
    };
    skills: {
      description: string;
      items: {
        catalog: { label: string; description: string };
        orders: { label: string; description: string };
        payments: { label: string; description: string };
        handoff: { label: string; description: string };
      };
    };
    mcp: {
      description: string;
      empty: string;
      addServer: string;
      removeServer: string;
      newServerTitle: string;
      idLabel: string;
      idHint: string;
      nameLabel: string;
      transportLabel: string;
      transportStdio: string;
      transportHttp: string;
      commandLabel: string;
      argsLabel: string;
      envLabel: string;
      envHint: string;
      cwdLabel: string;
      urlLabel: string;
      headersLabel: string;
      headersHint: string;
      testSuccessToast: string;
      testErrorTitle: string;
    };
    whatsapp: {
      connectedTitle: string;
      connectedDescription: string;
      awaitingTitle: string;
      awaitingDescription: string;
      waitingForQr: string;
      qrAlt: string;
      generateNewQr: string;
      generatingQr: string;
      forceDialogTitle: string;
      forceDialogDescription: string;
      forceConfirm: string;
      restartSuccessToast: string;
      restartErrorToast: string;
    };
    staff: {
      title: string;
      description: string;
      newTitle: string;
      newHint: string;
      nameLabel: string;
      emailLabel: string;
      passwordLabel: string;
      passwordHint: string;
      createButton: string;
      creating: string;
      createdToast: string;
      listTitle: string;
      emptyList: string;
      resetPasswordButton: string;
      deleteButton: string;
      deleteDialogTitle: string;
      deleteDialogDescription: string;
      deleteConfirm: string;
      deletedToast: string;
      resetDialogTitle: string;
      resetDialogDescription: string;
      newPasswordLabel: string;
      confirmPasswordLabel: string;
      passwordMismatch: string;
      passwordTooShort: string;
      resetSubmit: string;
      resetSuccessToast: string;
    };
  };
  wizard: {
    stepProgress: string;
    welcome: { title: string; subtitle: string; languagePrompt: string };
    admin: {
      title: string;
      subtitle: string;
      nameLabel: string;
      emailLabel: string;
      passwordLabel: string;
      passwordHint: string;
      confirmPasswordLabel: string;
      passwordMismatch: string;
      passwordTooShort: string;
      submit: string;
      submitting: string;
      alreadyDone: string;
      loginLink: string;
    };
    provider: { title: string; subtitle: string; skipLink: string };
    store: { title: string; subtitle: string; skipLink: string };
    skills: { title: string; subtitle: string; skipLink: string };
    mcp: { title: string; subtitle: string; skipLink: string };
    business: { title: string; subtitle: string };
    whatsapp: { title: string; subtitle: string; skipLink: string };
    done: { title: string; subtitle: string; goToDashboard: string };
    finishError: string;
  };
}

export const dictionaries: Record<Locale, Dictionary> = { es, en };

/** Ultimate fallback when there's no cookie and no (or non-Spanish) Accept-Language. */
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_COOKIE = 'arix_locale';

export function isLocale(value: string | undefined | null): value is Locale {
  return value === 'es' || value === 'en';
}

/** Client-only: persist the dashboard's display language for the next request
 * (read server-side by lib/i18n/server.ts's getLocale()). No-op during SSR. */
export function setLocaleCookie(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}

/** Fill `{token}` placeholders in a dictionary string, e.g. interpolate(t.wizard.stepProgress, {n: 2, total: 6}). */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`{${key}}`, String(value));
  return out;
}
