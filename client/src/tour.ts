import type { TourState } from "@cgwf/shared";

/**
 * The three-step tour shows once, after the first profile is created on this
 * device, until dismissed. "done" never comes back; the flag lives in
 * localStorage so it survives reloads but is per device, like the token.
 */
const TOUR_KEY = "cgwf.tour";

export function getTourState(): TourState {
  try {
    const v = localStorage.getItem(TOUR_KEY);
    return v === "pending" || v === "done" ? v : "none";
  } catch {
    return "none";
  }
}

export function setTourState(state: TourState): void {
  try {
    if (state === "none") localStorage.removeItem(TOUR_KEY);
    else localStorage.setItem(TOUR_KEY, state);
  } catch {
    /* private mode */
  }
}
