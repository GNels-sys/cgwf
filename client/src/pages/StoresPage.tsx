import { useEffect, useState } from "react";
import type { StoresResponse } from "@cgwf/shared";
import { api } from "../api";
import { SourceNote } from "../components/LocalStores";
import { relativeTime, statusMessage } from "../components/storeText";
import { PageHeading } from "../components/PageHeading";
import { RequireUser } from "../components/RequireUser";

const PLATFORM_LABELS: Record<string, string> = { shopify: "Online shop", crystalcommerce: "Online catalog", csv: "Shares its inventory" };

/** The Las Vegas stores the local-stock panels read from. Every link leaves CGwF for the store's own site. */
function StoresView() {
  const [data, setData] = useState<StoresResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    api.singles
      .stores(ctl.signal)
      .then((r) => { if (!ctl.signal.aborted) setData(r); })
      .catch((e: Error) => { if (!ctl.signal.aborted && e.name !== "AbortError") setError(e.message); });
    return () => ctl.abort();
  }, [tick]);

  if (error)
    return (
      <p className="error">
        {error}{" "}
        <button className="btn btn-small" type="button" onClick={() => setTick((t) => t + 1)}>
          Try again
        </button>
      </p>
    );
  if (!data) return <p className="muted">Loading stores…</p>;
  if (data.status !== "ok")
    return (
      <section className="surface">
        <p className="muted">{statusMessage(data)}</p>
        <SourceNote meta={data} snapshot={false} />
      </section>
    );

  return (
    <>
      <ul className="stores-list" role="list">
        {data.stores.map((s) => (
          <li key={s.id} className="store-card">
            <div className="store-card-head">
              <h2>
                <a href={s.website} target="_blank" rel="noopener noreferrer">
                  {s.name} <span aria-hidden="true">↗</span>
                </a>
              </h2>
              <span className="tag">{PLATFORM_LABELS[s.platform] ?? s.platform}</span>
            </div>
            <p className="store-card-where muted">
              {s.address ?? [s.city, s.state].filter(Boolean).join(", ") ?? "Las Vegas, NV"}
              {s.address ? "" : " · street address not on file"}
            </p>
            <dl className="store-card-facts">
              <div>
                <dt>Cards listed in stock</dt>
                <dd>{s.listingCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Inventory last read</dt>
                <dd>{relativeTime(s.lastRefresh)}</dd>
              </div>
            </dl>
            <p className="small">
              <a className="btn btn-small" href={s.website} target="_blank" rel="noopener noreferrer">
                Visit {s.name} <span aria-hidden="true">↗</span>
              </a>
            </p>
          </li>
        ))}
      </ul>
      {data.stores.length === 0 && <p className="muted">No stores are being read right now.</p>}
      <SourceNote meta={data} />
      <p className="small muted">
        Stock and prices come from each store&apos;s public listings, read a couple of times a day by the owner&apos;s Las Vegas singles site. CGwF only links to the stores; it never sells cards or takes a cut.
      </p>
    </>
  );
}

export function StoresPage() {
  return (
    <main className="page stores-page">
      <PageHeading title="Local stores" eyebrow="Las Vegas card shops">
        The shops behind the &ldquo;Available in Las Vegas&rdquo; panels. Tap a card or open a deck to see who has it in stock.
      </PageHeading>
      <RequireUser>
        <StoresView />
      </RequireUser>
    </main>
  );
}
