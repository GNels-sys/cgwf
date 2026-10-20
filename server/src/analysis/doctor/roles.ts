import { DOCTOR_ROLES, DOCTOR_ROLE_TARGETS, type DoctorRole, type DoctorRoleCount } from "@cgwf/shared";
import { isLand, type AnalysisCard } from "../cards.js";
import { findBoardWipes, findCardDraw, findProtection, findRamp, findRemoval, hitCount } from "../functional.js";

/**
 * Deck roles for the Deck Doctor, from the same regex finders the Stats panel uses (functional.ts), so
 * the two never disagree. A card can have several roles (Beast Within is removal; a land is a land).
 */
const FINDERS: Record<Exclude<DoctorRole, "land">, (cards: AnalysisCard[]) => Array<{ name: string; quantity: number }>> = {
  ramp: findRamp,
  draw: findCardDraw,
  removal: findRemoval,
  wipe: findBoardWipes,
  protection: findProtection,
};

export function rolesOf(card: AnalysisCard): DoctorRole[] {
  const out: DoctorRole[] = [];
  if (isLand(card)) out.push("land");
  for (const role of DOCTOR_ROLES) {
    if (role === "land") continue;
    if (FINDERS[role]([{ ...card, quantity: 1 }]).length > 0) out.push(role);
  }
  return out;
}

export function roleCounts(cards: AnalysisCard[]): DoctorRoleCount[] {
  return DOCTOR_ROLES.map((role) => ({
    role,
    have: role === "land" ? cards.filter((c) => c.board === "main" && isLand(c)).reduce((n, c) => n + c.quantity, 0) : hitCount(FINDERS[role](cards.filter((c) => c.board === "main"))),
    want: DOCTOR_ROLE_TARGETS[role],
  }));
}
