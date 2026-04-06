const specialKeyMap: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "BSpace",
  delete: "DC",
  del: "DC",
  space: "Space"
};

const modifierMap: Record<string, string> = {
  ctrl: "C",
  control: "C",
  alt: "M",
  meta: "M",
  shift: "S"
};

export type TmuxKeySendSpec =
  | {
      mode: "literal";
      value: string;
    }
  | {
      mode: "key";
      value: string;
    };

export function buildTmuxKeySendSpec(input: {
  key?: unknown;
  modifiers?: unknown;
}): TmuxKeySendSpec {
  const key = normalizeKey(input.key);
  if (!key) {
    throw new Error("send_key requires a key");
  }

  const modifiers = normalizeModifiers(input.modifiers);
  if (modifiers.length === 0 && isLiteralKey(key)) {
    return {
      mode: "literal",
      value: key
    };
  }

  const tmuxKey = specialKeyMap[key] ?? normalizeTmuxLiteralKey(key);
  if (!tmuxKey) {
    throw new Error(`unsupported send_key target: ${key}`);
  }

  return {
    mode: "key",
    value: modifiers.length > 0 ? `${modifiers.join("-")}-${tmuxKey}` : tmuxKey
  };
}

function normalizeKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const key = value.trim();
  if (!key) {
    return undefined;
  }

  return key.toLowerCase();
}

function normalizeModifiers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .map((item) => (typeof item === "string" ? modifierMap[item.trim().toLowerCase()] : undefined))
    .filter((item): item is string => Boolean(item));

  return [...new Set(normalized)];
}

function isLiteralKey(key: string): boolean {
  return key.length === 1;
}

function normalizeTmuxLiteralKey(key: string): string | undefined {
  if (key.length !== 1) {
    return undefined;
  }

  return /^[ -~]$/.test(key) ? key : undefined;
}
