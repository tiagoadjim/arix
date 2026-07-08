import type { Dictionary } from './index';

export const en: Dictionary = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    retry: 'Retry',
    loading: 'Loading…',
    error: 'Something went wrong.',
  },
  login: {
    title: 'Arix',
    subtitle: 'Staff console',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    submit: 'Sign in',
    submitting: 'Signing in…',
    errorGeneric: 'Login error',
  },
  sidebar: {
    filterAll: 'All',
    filterHuman: 'With human',
    filterUnread: 'Unread',
    unread: 'unread',
    emptyList: 'No conversations.',
    fetchError: "Couldn't refresh the inbox.",
    muteOnTooltip: 'Sound on — click to mute',
    muteOffTooltip: 'Sound muted — click to unmute',
    muteOnAria: 'Mute sounds',
    muteOffAria: 'Unmute sounds',
    agentsNav: 'Agents',
    settingsNav: 'Settings',
    signOut: 'Sign out',
    modeHuman: 'Human',
    themeToLight: 'Switch to light theme',
    themeToDark: 'Switch to dark theme',
  },
  panelHome: {
    hint: 'Select a conversation',
  },
  time: {
    now: 'now',
  },
};
