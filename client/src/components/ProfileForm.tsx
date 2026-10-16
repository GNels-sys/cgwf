import { useState, type FormEvent } from "react";
import {
  AVATAR_COLORS,
  AVATAR_EMOJI,
  AVATARS,
  DISPLAY_NAME_MAX,
  type AvatarColorKey,
  type AvatarKey,
  type RegisterRequest,
} from "@cgwf/shared";
import { Avatar } from "./Avatar";

interface Props {
  initial?: Partial<RegisterRequest>;
  submitLabel: string;
  onSubmit: (body: RegisterRequest) => Promise<void>;
}

/** Name + avatar + colour picker, used for first run and for editing. */
export function ProfileForm({ initial, submitLabel, onSubmit }: Props) {
  const [displayName, setDisplayName] = useState(initial?.displayName ?? "");
  const [avatar, setAvatar] = useState<AvatarKey>(initial?.avatar ?? "dragon");
  const [color, setColor] = useState<AvatarColorKey>(initial?.color ?? "gold");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ displayName: displayName.trim(), avatar, color });
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="profile-form" onSubmit={submit}>
      <div className="profile-preview">
        <Avatar avatar={avatar} color={color} size={72} />
        <strong>{displayName.trim() || "Your name"}</strong>
      </div>
      <label className="field">
        <span>Display name</span>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="nickname"
          placeholder="What your friends call you"
          required
        />
      </label>
      <fieldset className="field">
        <legend>Avatar</legend>
        <div className="avatar-grid">
          {AVATARS.map((a) => (
            <button
              type="button"
              key={a}
              className={`avatar-option${a === avatar ? " is-selected" : ""}`}
              onClick={() => setAvatar(a)}
              aria-label={a}
              aria-pressed={a === avatar}
            >
              {AVATAR_EMOJI[a]}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>Colour</legend>
        <div className="color-row">
          {(Object.keys(AVATAR_COLORS) as AvatarColorKey[]).map((c) => (
            <button
              type="button"
              key={c}
              className={`color-option${c === color ? " is-selected" : ""}`}
              style={{ background: AVATAR_COLORS[c] }}
              onClick={() => setColor(c)}
              aria-label={c}
              aria-pressed={c === color}
            />
          ))}
        </div>
      </fieldset>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy || !displayName.trim()}>
        {busy ? "Saving..." : submitLabel}
      </button>
    </form>
  );
}
