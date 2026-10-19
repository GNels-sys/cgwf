import { describe, expect, it } from "vitest";
import { isTokenCard, pickPurchaseUris, shouldKeep, toCardRow, toPurchaseLinks, type ScryfallCard } from "./map.js";
import sample from "./fixtures/cards.sample.json" with { type: "json" };

const cards = sample as ScryfallCard[];
const byName = (name: string) => cards.find((c) => c.name === name && (c.lang ?? "en") === "en")!;

describe("toCardRow layouts", () => {
  it("normal card keeps its single image and oracle text", () => {
    const row = toCardRow(byName("Sol Ring"), 1);
    expect(row.layout).toBe("normal");
    expect(row.imageFront?.normal).toContain("/normal/front/");
    expect(row.imageBack).toBeNull();
    expect(row.oracleText).toBe("{T}: Add {C}{C}.");
    expect(row.normalizedName).toBe("sol ring");
    expect(row.isToken).toBe(false);
  });

  it("transform card gets a back image and a joined mana cost", () => {
    const row = toCardRow(byName("Delver of Secrets // Insectile Aberration"), 1);
    expect(row.layout).toBe("transform");
    expect(row.imageFront?.normal).toContain("/front/");
    expect(row.imageBack?.normal).toContain("/back/");
    expect(row.manaCost).toBe("{U}");
    expect(row.faces).toHaveLength(2);
    expect((row.faces[1] as { hasOwnImage: boolean }).hasOwnImage).toBe(true);
    expect(row.power).toBe("1");
  });

  it("split, adventure and flip cards have two faces but one image", () => {
    for (const name of ["Fire // Ice", "Bonecrusher Giant // Stomp", "Akki Lavarunner // Tok-Tok, Volcano Born"]) {
      const row = toCardRow(byName(name), 1);
      expect(row.faces).toHaveLength(2);
      expect(row.imageFront).not.toBeNull();
      expect(row.imageBack).toBeNull();
    }
    expect(toCardRow(byName("Fire // Ice"), 1).manaCost).toBe("{1}{R} // {1}{U}");
  });

  it("tokens are flagged", () => {
    const treasure = byName("Treasure");
    expect(isTokenCard(treasure)).toBe(true);
    expect(toCardRow(treasure, 1).isToken).toBe(true);
    expect(isTokenCard(byName("Sol Ring"))).toBe(false);
  });
});

describe("toCardRow printing look", () => {
  it("stores the treatment fields and marks only plain printings regular", () => {
    const plain = toCardRow({ ...byName("Sol Ring"), set_type: "commander", frame: "2015", border_color: "black", frame_effects: [], promo: false, finishes: ["nonfoil", "foil"] }, 1);
    expect(plain).toMatchObject({ setType: "commander", frame: "2015", borderColor: "black", finishes: ["nonfoil", "foil"], isRegular: true });
    const fancy = toCardRow({ ...byName("Sol Ring"), border_color: "borderless", frame_effects: ["inverted"], promo_types: ["boosterfun"], full_art: true }, 1);
    expect(fancy).toMatchObject({ borderColor: "borderless", frameEffects: ["inverted"], promoTypes: ["boosterfun"], fullArt: true, isRegular: false });
    expect(toCardRow({ ...byName("Sol Ring"), set: "sld", set_type: "box" }, 1).isRegular).toBe(false);
  });
});

describe("shouldKeep", () => {
  it("drops non-English printings", () => {
    const ja = cards.find((c) => c.lang === "ja")!;
    expect(shouldKeep(ja)).toBe(false);
    expect(shouldKeep(byName("Sol Ring"))).toBe(true);
  });
  it("drops art series", () => {
    expect(shouldKeep({ ...byName("Sol Ring"), layout: "art_series" })).toBe(false);
  });
});

describe("purchase_uris (Phase 10)", () => {
  it("keeps tcgplayer, cardmarket and cardhoarder https links and drops everything else", () => {
    const row = toCardRow(byName("Sol Ring"), 1);
    expect(row.purchaseUris).toEqual({
      tcgplayer: expect.stringContaining("https://www.tcgplayer.com/product/223733"),
      cardmarket: expect.stringContaining("https://www.cardmarket.com/"),
      cardhoarder: expect.stringContaining("https://www.cardhoarder.com/"),
    });
    expect(Object.keys(row.purchaseUris ?? {})).not.toContain("ebay");
    expect(Object.keys(row.purchaseUris ?? {})).not.toContain("amazon");
  });

  it("stores null when Scryfall lists no links, and the API shape fills every key", () => {
    const bolt = cards.find((c) => c.name === "Lightning Bolt")!;
    expect(toCardRow(bolt, 1).purchaseUris).toBeNull();
    expect(toPurchaseLinks(null)).toBeNull();
    expect(toPurchaseLinks({ tcgplayer: "https://t" })).toEqual({ tcgplayer: "https://t", cardmarket: null, cardhoarder: null });
    expect(pickPurchaseUris({ tcgplayer: "http://insecure", cardmarket: "javascript:alert(1)" })).toBeNull();
  });
});
