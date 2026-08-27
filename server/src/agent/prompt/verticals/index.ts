import type { Language } from '../../hours';
import type { Vertical } from '../../../verticals';
import type { PromptParams } from '../index';
import { ecommercePacks } from './ecommerce';
import { servicesPacks } from './services';
import { appointmentsPacks } from './appointments';

/**
 * A vertical pack supplies the domain-specific half of the system prompt.
 *
 * The neutral half — persona, message style, continuity, language lock,
 * anti-injection, media handling — lives in prompt/es.ts and prompt/en.ts and
 * is identical for every business. Everything that only makes sense for a
 * particular kind of business is here: how a customer transacts, what the
 * open/closed status licenses the agent to promise, which capabilities to
 * advertise, and which topics are in scope.
 *
 * Adding a vertical means adding one file here, not editing the base prompt.
 */
export interface VerticalPack {
  /**
   * Trailing hint on the "# Date & time" heading — what the agent must read it
   * before doing. A shop reads it before promising a delivery; a salon reads it
   * before quoting an opening time.
   */
  dateHeadingHint: string;
  /**
   * Business-info block appended right after the date/time status line.
   *
   * Returns '' when nothing is configured, otherwise a string that STARTS with
   * its own '\n\n'. The leading separator lives in the section (rather than in
   * the caller) because this block is concatenated directly onto the status
   * line, with no blank line when it is absent.
   */
  infoSection(p: PromptParams): string;
  /** How a customer actually transacts — buys on the site, books a slot, … */
  transactionSection(p: PromptParams): string;
  /** What the open/closed status above licenses the agent to promise. */
  hoursSection(p: PromptParams): string;
  /** Capability list, composed from the tools advertised for this turn. */
  skillsSection(p: PromptParams): string;
  /** Domain bullets prepended to the neutral "# Rules" list, without "- ". */
  domainRules(p: PromptParams): string[];
  /** Topic restriction — what this agent will and won't discuss. */
  scopeSection(p: PromptParams): string;
}

export type VerticalPacks = Record<Language, VerticalPack>;

const PACKS: Record<Vertical, VerticalPacks> = {
  ecommerce: ecommercePacks,
  services: servicesPacks,
  appointments: appointmentsPacks,
};

export function packFor(vertical: Vertical, language: Language): VerticalPack {
  return PACKS[vertical][language];
}

/** Join prompt sections with a blank line, dropping the ones a vertical omits
 * (an empty section would otherwise leave a double blank line behind). */
export function joinSections(...sections: string[]): string {
  return sections.filter((s) => s.trim() !== '').join('\n\n');
}
