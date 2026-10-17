import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { BridgeMeta, CardAvailabilityResponse, PurchaseLinks as PurchaseLinkSet, ShoppingReport } from "@cgwf/shared";
import { api } from "../api";
import { useUser } from "../user";
import { conditionLabel, finishLabel, linkLabel, money, sourceSentence, statusMessage } from "./storeText";

/**
 * Phase 10 local-stores panels. CGwF only links out and never sells anything:
 * every link here leaves the app for the store's own site or one of Scryfall's
 * marketplace links. Each panel says where its data came from and how old it is.
 */

const OUT = { target: "_blank", rel: "noopener noreferrer" } as const;

/** The "updated X ago, from local store data" line that sits under every panel. */
export function SourceNote({ meta, snapshot = true }: { meta: Pick<BridgeMeta, "status" | "dataAsOf" | "cached">; snapshot?: boolean }) {
  return (
    <p className="local-source small muted">
      {sourceSentence(meta)}
      {snapshot && meta.status === "ok" ? " Stock is a snapshot; confirm with the store before visiting." : ""}
    </p>
  );
}

/** Scryfall's marketplace links for a printing: three plain outbound buttons. */
export function PurchaseLinks({ links, heading = "Buy online" }: { links: PurchaseLinkSet | null | undefined; heading?: string }) {
  const entries: Array<[string, string]> = [];
  if (links?.tcgplayer) entries.push(["TCGplayer", links.tcgplayer]);
  if (links?.cardmarket) entries.push(["Cardmarket", links.cardmarket]);
  if (links?.cardhoarder) entries.push(["Cardhoarder", links.cardhoarder]);
  if (entries.length === 0) return null;
  return (
    <div className="purchase-links">
      <span className="purchase-links-label small muted">{heading}</span>
      <div className="purchase-links-row">
        {entries.map(([name, href]) => (
          <a key={name} className="btn btn-small purchase-link" href={href} {...OUT}>
            {name} <span aria-hidden="true">↗</span>
          </a>
        ))}
      </div>
      <p className="small muted purchase-links-note">Links go to those stores (via Scryfall). CGwF sells nothing.</p>
    </div>
  );
}

/** "Available in Las Vegas": stores that stock any printing of the card, cheapest store first. */
export function AvailabilityPanel({ cardId }: { cardId: string }) {
  const { user } = useUser();
  const [data, setData] = useState<CardAvailabilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!user) return;
    const ctl = new AbortController();
    setData(null);
    setError(null);
    api.singles
      .availability(cardId, ctl.signal)
      .then((r) => { if (!ctl.signal.aborted) setData(r); })
      .catch((e: Error) => { if (!ctl.signal.aborted && e.name !== "AbortError") setError(e.message); });
    return () => ctl.abort();
  }, [cardId, user, tick]);

  if (!user) return null;
  // The owner has not switched the bridge on: say nothing rather than apologise on every card.
  if (data && data.status === "unconfigured") return null;
  return (
    <section className="local-panel" aria-labelledby={`lv-${cardId}`}>
      <div className="row-between">
        <h3 id={`lv-${cardId}`}>Available in Las Vegas</h3>
        {data && data.status === "ok" && data.stores.length > 0 && <span className="tag tag-ok">{data.stores.length === 1 ? "1 store" : `${data.stores.length} stores`}</span>}
      </div>
      {error && (
        <p className="small error">
          {error}{" "}
          <button className="btn btn-small" type="button" onClick={() => setTick((t) => t + 1)}>
            Try again
          </button>
        </p>
      )}
      {!data && !error && <p className="muted small" role="status">Checking local stores…</p>}
      {data && data.status !== "ok" && <p className="small muted local-unavailable">{statusMessage(data)}</p>}
      {data && data.status === "ok" && data.stores.length === 0 && <p className="small muted">No Las Vegas store lists this card in stock right now.</p>}
      {data && data.status === "ok" && data.stores.length > 0 && (
        <ul className="store-offers" role="list">
          {data.stores.map((s) => (
            <li key={s.store.id} className="store-offer">
              <div className="store-offer-head">
                <a className="store-offer-name" href={s.store.website} {...OUT}>
                  {s.store.name} <span aria-hidden="true">↗</span>
                </a>
                <span className="store-offer-from">{s.cheapest == null ? "price not listed" : `from ${money(s.cheapest)}`}</span>
              </div>
              <ul className="offer-rows" role="list">
                {s.listings.slice(0, 6).map((l, i) => (
                  <li key={`${l.url}-${i}`} className="offer-row">
                    <span className="offer-price">{money(l.price, l.currency)}</span>
                    <span className="offer-meta">
                      {finishLabel(l.finish)} · {conditionLabel(l.condition)}
                      {l.quantity != null ? ` · ${l.quantity} in stock` : ""}
                      {l.setName ? ` · ${l.setName}` : ""}
                    </span>
                    <a className="offer-link" href={l.url} {...OUT}>
                      {linkLabel(l.urlKind)} <span aria-hidden="true">↗</span>
                    </a>
                  </li>
                ))}
                {s.listings.length > 6 && (
                  <li className="offer-row offer-more small muted">
                    {s.listings.length - 6} more at this store ·{" "}
                    <a href={s.listings[0]!.searchUrl} {...OUT}>
                      see them all <span aria-hidden="true">↗</span>
                    </a>
                  </li>
                )}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {data && <SourceNote meta={data} />}
      {data && data.status !== "ok" && data.purchaseLinks && <p className="small muted">The online links below still work.</p>}
    </section>
  );
}

/** The deck shopping panel: cheapest local pick per card, per-store coverage, best single store. */
export function ShoppingPanel({ load, version }: { load: () => Promise<ShoppingReport>; version: string }) {
  const [report, setReport] = useState<ShoppingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCards, setShowCards] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await load());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [load]);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, version]);

  const r = report;
  return (
    <section className="local-panel shopping-panel" aria-labelledby="shopping-title">
      <div className="row-between">
        <h3 id="shopping-title">Shop locally</h3>
        <button className="btn btn-small" type="button" disabled={busy} onClick={() => void run()}>
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
      <p className="small muted shopping-lead">Which Las Vegas stores stock this deck, from the Singles site's latest scrape. Prices are each store's listed price; CGwF sells nothing.</p>
      {error && <p className="small error">{error}</p>}
      {!r && !error && <p className="muted small" role="status">Checking local stores…</p>}
      {r && r.status !== "ok" && <p className="small muted local-unavailable">{statusMessage(r)}</p>}
      {r && r.status === "ok" && (
        <>
          <ul className="shop-summary" role="list">
            <li>
              <span className="shop-summary-value">{r.summary.cardsAvailable}<span className="muted"> / {r.summary.cardsTotal}</span></span>
              <span className="shop-summary-label">cards in a local store</span>
            </li>
            <li>
              <span className="shop-summary-value">{money(r.summary.cheapestAnywhereTotal)}</span>
              <span className="shop-summary-label">cheapest, mixing stores</span>
            </li>
            <li>
              <span className="shop-summary-value">{r.bestStore ? r.bestStore.store.name : "—"}</span>
              <span className="shop-summary-label">{r.bestStore ? `best single store · ${r.bestStore.cardsCovered} of ${r.bestStore.cardsTotal} for ${money(r.bestStore.total)}` : "no store has any of it"}</span>
            </li>
          </ul>
          {r.stores.length > 0 && (
            <ul className="shop-stores" role="list">
              {r.stores.map((s) => (
                <li key={s.store.id} className={`shop-store${r.bestStore?.store.id === s.store.id ? " is-best" : ""}`}>
                  <div className="shop-store-head">
                    <a className="store-offer-name" href={s.store.website} {...OUT}>
                      {s.store.name} <span aria-hidden="true">↗</span>
                    </a>
                    {r.bestStore?.store.id === s.store.id && <span className="tag tag-ok">Best single store</span>}
                  </div>
                  <div className="shop-store-bar" aria-hidden="true">
                    <span style={{ width: `${s.cardsTotal ? (s.cardsCovered / s.cardsTotal) * 100 : 0}%` }} />
                  </div>
                  <p className="small shop-store-line">
                    <strong>{s.cardsCovered}</strong> of {s.cardsTotal} cards · {money(s.total)} at this store&apos;s cheapest prices
                    {s.missing.length > 0 && s.missing.length <= 8 && <span className="muted"> · missing {s.missing.join(", ")}</span>}
                    {s.missing.length > 8 && <span className="muted"> · missing {s.missing.length} cards</span>}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {r.summary.missingNames.length > 0 && (
            <p className="small muted shop-missing">
              Not in any local store ({r.summary.missingNames.length}): {r.summary.missingNames.slice(0, 12).join(", ")}
              {r.summary.missingNames.length > 12 ? ", …" : ""}. Online links for those are on each card.
            </p>
          )}
          <button className="btn btn-small shop-toggle" type="button" aria-expanded={showCards} onClick={() => setShowCards((v) => !v)}>
            {showCards ? "Hide the card list" : `Show every card (${r.cards.length})`}
          </button>
          {showCards && (
            <div className="shop-cards-wrap">
              <table className="shop-cards">
                <thead>
                  <tr>
                    <th scope="col">Card</th>
                    <th scope="col">Cheapest locally</th>
                    <th scope="col">Where</th>
                    <th scope="col"><span className="sr-only">Links</span></th>
                  </tr>
                </thead>
                <tbody>
                  {r.cards.map((c) => (
                    <tr key={`${c.cardId}-${c.board}`} className={c.cheapest ? "" : "is-missing"}>
                      <td>
                        {c.quantity > 1 && <span className="qty">{c.quantity}</span>} {c.name}
                        {c.board === "commander" && <span className="muted small"> · commander</span>}
                      </td>
                      <td>{c.cheapest ? `${money(c.cheapest.price)} · ${finishLabel(c.cheapest.finish)} · ${conditionLabel(c.cheapest.condition)}` : <span className="muted">not local</span>}</td>
                      <td>{c.cheapest ? `${c.cheapest.storeName}${c.storeIds.length > 1 ? ` +${c.storeIds.length - 1}` : ""}` : ""}</td>
                      <td className="shop-cards-links">
                        {c.cheapest && (
                          <a href={c.cheapest.url} {...OUT}>
                            Local <span aria-hidden="true">↗</span>
                          </a>
                        )}
                        {c.purchaseLinks?.tcgplayer && (
                          <a href={c.purchaseLinks.tcgplayer} {...OUT}>
                            TCGplayer <span aria-hidden="true">↗</span>
                          </a>
                        )}
                        {!c.cheapest && !c.purchaseLinks?.tcgplayer && c.purchaseLinks?.cardmarket && (
                          <a href={c.purchaseLinks.cardmarket} {...OUT}>
                            Cardmarket <span aria-hidden="true">↗</span>
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {r && <SourceNote meta={r} />}
      <p className="small muted">
        <Link to="/stores">About the stores</Link>
      </p>
    </section>
  );
}
