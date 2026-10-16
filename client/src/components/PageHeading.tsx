import type { ReactNode } from "react";

/** Shared page hierarchy; actions and page state remain with their owning page. */
export function PageHeading({ title, eyebrow, children, actions, illustrated = false }: {
  title: string;
  eyebrow: string;
  children: ReactNode;
  actions?: ReactNode;
  illustrated?: boolean;
}) {
  return (
    <header className={`page-intro${illustrated ? " is-illustrated" : ""}`}>
      <div className="page-intro-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-intro-description">{children}</p>
      </div>
      <div className="page-intro-trailing">
        <span className="page-intro-emblem" aria-hidden="true">◇</span>
        {actions}
      </div>
    </header>
  );
}
