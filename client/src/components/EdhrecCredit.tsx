import type { LibraryDeckSummary } from "@cgwf/shared";

/**
 * Attribution and import notes for library decks that came from EDHREC (source "edhrec").
 * The decks are EDHREC's synthesised averages; nothing else from EDHREC is republished.
 */
export function EdhrecCredit({ deck, compact = false }: { deck: Pick<LibraryDeckSummary, "source" | "sourceUrl" | "importInfo">; compact?: boolean }) {
  if (deck.source !== "edhrec") return null;
  const info = deck.importInfo;
  const missing = info?.coverage?.missing ?? [];
  const link = (
    <a href={deck.sourceUrl ?? "https://edhrec.com"} target="_blank" rel="noreferrer">
      Average deck data from EDHREC
    </a>
  );
  if (compact) {
    // Used inside a row that is itself a link: plain text here (no nested anchor); the deck page links to EDHREC.
    return (
      <span className="edhrec-credit small muted">
        Average deck data from EDHREC
        {info?.mismatch ? <span className="chip tag-chip small is-warn" title={info.mismatch}>bracket?</span> : null}
        {missing.length ? <span className="chip tag-chip small is-warn" title={`Forge cannot play: ${missing.join(", ")}`}>not for bots</span> : null}
      </span>
    );
  }
  return (
    <div className="notice edhrec-credit-box">
      <p className="small">
        {link}. EDHREC's synthesised average for this commander at {info ? `its "${info.edhrecBracket}" bracket` : "this bracket"}: the card each slot holds most often across {info ? `${info.decks.toLocaleString()} indexed decks` : "the decks EDHREC indexes"}, not one player's list.
        {info ? ` Win condition: ${info.winCondition}. Picked because: ${info.pickReason}.` : ""}
      </p>
      {info?.mismatch && <p className="small warn">Bracket check: {info.mismatch}. EDHREC's bracket is kept; change it above if you disagree.</p>}
      {missing.length > 0 && <p className="small warn">The rules engine cannot play {missing.join(", ")}, so computer opponents never pick this deck. People can still play it.</p>}
      {!info?.coverage && info?.coverageError && <p className="small muted">Rules-engine coverage not checked yet ({info.coverageError}).</p>}
    </div>
  );
}
