import { useState } from "react";
import { cardImagePath, type ImageSize } from "@cgwf/shared";

interface Props {
  id: string;
  name: string;
  size?: ImageSize;
  face?: 0 | 1;
  className?: string;
  loading?: "lazy" | "eager";
}

/**
 * A card image served through our own cache. Shown whole, at the card's real
 * aspect ratio (63 x 88), never cropped. A name placeholder shows while loading.
 */
export function CardImage({ id, name, size = "normal", face = 0, className = "", loading = "lazy" }: Props) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  return (
    <div className={`card-image ${className}`}>
      {state !== "ok" && (
        <div className={`card-image-placeholder${state === "error" ? " is-error" : ""}`}>
          <span>{name}</span>
          {state === "error" && <small>image unavailable</small>}
        </div>
      )}
      <img
        src={cardImagePath(id, size, face)}
        alt={name}
        loading={loading}
        decoding="async"
        onLoad={() => setState("ok")}
        onError={() => setState("error")}
        style={{ opacity: state === "ok" ? 1 : 0 }}
      />
    </div>
  );
}
