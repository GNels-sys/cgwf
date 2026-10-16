/**
 * Phase 8 onboarding decisions, kept pure so the routing can be unit-tested
 * without a browser.
 */

export interface LandingInput {
  /** This device holds a session token (it may still turn out to be dead). */
  hasToken: boolean;
  /** The first /api/me round trip has not settled yet. */
  loading: boolean;
  /** A profile is known on this device. */
  signedIn: boolean;
}

export type Landing = "loading" | "welcome" | "app";

/** What the root URL should show: the welcome screen for signed-out visitors, the app otherwise. */
export function landingFor(input: LandingInput): Landing {
  if (input.signedIn) return "app";
  if (input.hasToken && input.loading) return "loading";
  return "welcome";
}

export type TourState = "pending" | "done" | "none";

/** The three-step tour shows once, right after the first profile is created, until dismissed. */
export function shouldShowTour(state: TourState, signedIn: boolean): boolean {
  return signedIn && state === "pending";
}

export const TOUR_STEPS: ReadonlyArray<{ title: string; body: string; to: string; cta: string }> = [
  {
    title: "Import a deck",
    body: "Paste a decklist from Archidekt, Moxfield, MTGGoldfish, TappedOut or Arena. Every card gets its real image and a Commander Bracket read-out.",
    to: "/decks/new",
    cta: "Import a deck",
  },
  {
    title: "Join or host a table",
    body: "Open Play, start a table and share its six-character code, or type a friend's code to join theirs. Up to four players plus spectators.",
    to: "/play",
    cta: "Open Play",
  },
  {
    title: "Personalize",
    body: "Pick a playmat, card sleeves, a table theme and your layout. Friends see your playmat and sleeves at the table.",
    to: "/settings",
    cta: "Personalize",
  },
];
