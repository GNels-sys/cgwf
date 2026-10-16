import { AVATAR_COLORS, AVATAR_EMOJI, type AvatarColorKey, type AvatarKey } from "@cgwf/shared";

export function Avatar({ avatar, color, size = 36 }: { avatar: AvatarKey; color: AvatarColorKey; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.55, background: AVATAR_COLORS[color] }}
      aria-hidden="true"
    >
      {AVATAR_EMOJI[avatar]}
    </span>
  );
}
