import { useEffect, useRef, useState } from "react";
import {
  ACCENTS,
  AMBIENT_LOOPS,
  CARD_SCALE_MAX,
  CARD_SCALE_MIN,
  OPPONENT_SIZES,
  PLAYMAT_PRESETS,
  SLEEVE_PRESETS,
  TABLE_THEMES,
  UPLOAD_MAX_BYTES,
  type AccentKey,
  type Texture,
  type UploadInfo,
  type UploadKind,
} from "@cgwf/shared";
import { api } from "../api";
import { useSettings } from "../settings";
import { PLAYMAT_LABELS, SLEEVE_LABELS, THEME_LABELS, textureStyle, useUploadUrl } from "./look";

/**
 * Personalize: playmat, sleeves, table theme, accent, light/dark, ambient sound
 * and layout. Every change applies immediately (the provider saves it) so the
 * player can judge it on the live table behind the panel.
 */

function UploadSwatch({ id, selected, onPick, onRemove }: { id: string; selected: boolean; onPick: () => void; onRemove: () => void }) {
  const url = useUploadUrl(id);
  return (
    <div className={`swatch-wrap${selected ? " is-selected" : ""}`}>
      <button type="button" className="swatch is-upload" style={textureStyle(url)} onClick={onPick} aria-label="Your uploaded image" aria-pressed={selected}>
        {!url && <span className="muted small">...</span>}
      </button>
      <button type="button" className="swatch-remove" onClick={onRemove} aria-label="Delete this image">
        &times;
      </button>
    </div>
  );
}

function TexturePicker({
  kind,
  presets,
  labels,
  prefix,
  value,
  onChange,
}: {
  kind: UploadKind;
  presets: readonly string[];
  labels: Record<string, string>;
  prefix: "mat" | "sleeve";
  value: Texture;
  onChange: (t: Texture) => void;
}) {
  const [uploads, setUploads] = useState<UploadInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.uploads
      .list()
      .then((r) => setUploads(r.uploads.filter((u) => u.kind === kind)))
      .catch(() => setUploads([]));
  }, [kind]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > UPLOAD_MAX_BYTES) {
      setError(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError("Pick an image file (JPEG, PNG, WebP or GIF).");
      return;
    }
    setBusy(true);
    try {
      const info = await api.uploads.create(kind, file);
      setUploads((u) => [...u, info]);
      onChange({ kind: "upload", id: info.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async (id: string) => {
    try {
      await api.uploads.remove(id);
      setUploads((u) => u.filter((x) => x.id !== id));
      if (value.kind === "upload" && value.id === id) onChange({ kind: "preset", id: presets[0]! });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="texture-picker">
      <div className="swatches">
        {presets.map((id) => {
          const selected = value.kind === "preset" && value.id === id;
          return (
            <button
              key={id}
              type="button"
              className={`swatch ${prefix}-${id}${selected ? " is-selected" : ""}`}
              onClick={() => onChange({ kind: "preset", id })}
              aria-label={labels[id] ?? id}
              aria-pressed={selected}
              title={labels[id] ?? id}
            >
              {prefix === "sleeve" && <span className="swatch-mark">CGwF</span>}
            </button>
          );
        })}
        {uploads.map((u) => (
          <UploadSwatch key={u.id} id={u.id} selected={value.kind === "upload" && value.id === u.id} onPick={() => onChange({ kind: "upload", id: u.id })} onRemove={() => void remove(u.id)} />
        ))}
        <label className={`swatch is-add${busy ? " is-busy" : ""}`} title="Upload an image">
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => void upload(e.target.files?.[0])} disabled={busy} />
          <span>{busy ? "..." : "+"}</span>
          <span className="small">Upload</span>
        </label>
      </div>
      <p className="muted small">
        {value.kind === "preset" ? (labels[value.id] ?? value.id) : "Your image"} &middot; JPEG, PNG, WebP or GIF up to {UPLOAD_MAX_BYTES / 1024 / 1024} MB. Only players at your table can see it.
      </p>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function SettingsPanel() {
  const { settings, update, saving, error } = useSettings();
  const layout = settings.layout;
  return (
    <div className="settings">
      <section>
        <h3>Playmat</h3>
        <p className="muted small">Shown under your cards; opponents see it when they look at your side of the table.</p>
        <TexturePicker kind="playmat" presets={PLAYMAT_PRESETS} labels={PLAYMAT_LABELS} prefix="mat" value={settings.playmat} onChange={(playmat) => update({ playmat })} />
      </section>
      <section>
        <h3>Card sleeves</h3>
        <p className="muted small">The back of your library and hidden cards, as everyone sees them.</p>
        <TexturePicker kind="sleeve" presets={SLEEVE_PRESETS} labels={SLEEVE_LABELS} prefix="sleeve" value={settings.sleeve} onChange={(sleeve) => update({ sleeve })} />
      </section>
      <section>
        <h3>Room</h3>
        <div className="setting-row">
          <span>Table</span>
          <div className="chips">
            {TABLE_THEMES.map((t) => (
              <button key={t} type="button" className={`chip${settings.theme === t ? " is-selected" : ""}`} onClick={() => update({ theme: t })} aria-pressed={settings.theme === t}>
                {THEME_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>Accent</span>
          <div className="chips">
            {(Object.keys(ACCENTS) as AccentKey[]).map((a) => (
              <button key={a} type="button" className={`color-option${settings.accent === a ? " is-selected" : ""}`} style={{ background: ACCENTS[a] }} onClick={() => update({ accent: a })} aria-label={a} aria-pressed={settings.accent === a} />
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>Interface</span>
          <div className="chips">
            {(["dark", "light"] as const).map((ui) => (
              <button key={ui} type="button" className={`chip${settings.ui === ui ? " is-selected" : ""}`} onClick={() => update({ ui })} aria-pressed={settings.ui === ui}>
                {ui === "dark" ? "Dark" : "Light"}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>Ambient sound</span>
          <div className="chips">
            {AMBIENT_LOOPS.map((a) => (
              <button key={a} type="button" className={`chip${settings.ambient === a ? " is-selected" : ""}`} onClick={() => update({ ambient: a })} aria-pressed={settings.ambient === a}>
                {a === "none" ? "Off" : a === "rain" ? "Rain" : "Fireplace"}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section>
        <h3>Layout</h3>
        <label className="setting-row">
          <span>Card size</span>
          <span className="range-wrap">
            <input type="range" min={CARD_SCALE_MIN} max={CARD_SCALE_MAX} step={0.05} value={layout.cardScale} onChange={(e) => update({ layout: { cardScale: Number(e.target.value) } })} aria-label="Card size" />
            <span className="muted small">{Math.round(layout.cardScale * 100)}%</span>
          </span>
        </label>
        <div className="setting-row">
          <span>Hand</span>
          <div className="chips">
            {(["bottom", "top"] as const).map((h) => (
              <button key={h} type="button" className={`chip${layout.hand === h ? " is-selected" : ""}`} onClick={() => update({ layout: { hand: h } })} aria-pressed={layout.hand === h}>
                {h === "bottom" ? "Bottom" : "Top"}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>Opponents</span>
          <div className="chips">
            {(["strip", "around"] as const).map((o) => (
              <button key={o} type="button" className={`chip${layout.opponents === o ? " is-selected" : ""}`} onClick={() => update({ layout: { opponents: o } })} aria-pressed={layout.opponents === o}>
                {o === "strip" ? "In a row" : "Around the table"}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <span>Opponent panels</span>
          <div className="chips">
            {OPPONENT_SIZES.map((s) => (
              <button key={s} type="button" className={`chip${layout.opponentSize === s ? " is-selected" : ""}`} onClick={() => update({ layout: { opponentSize: s } })} aria-pressed={layout.opponentSize === s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <label className="setting-row">
          <span>Compact mode</span>
          <span className="toggle">
            <input type="checkbox" checked={layout.compact} onChange={(e) => update({ layout: { compact: e.target.checked } })} />
            <span className="small">Tighter spacing, smaller labels</span>
          </span>
        </label>
      </section>
      <p className="muted small" aria-live="polite">
        {error ? <span className="error">Could not save: {error}</span> : saving ? "Saving..." : "Saved to your account; applied on every device you sign in on."}
      </p>
    </div>
  );
}
