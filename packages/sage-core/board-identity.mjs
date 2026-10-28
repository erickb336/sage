import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Decode exact UTF-8 bytes and remove only the newline that checkout.txt puts after the path. */
export const decodeCheckout = bytes => {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
};

/** A checkout is usable as identity only when its absolute path resolves to a directory. */
export function checkoutIdentity(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function sameCheckout(first, second) {
  const identity = checkoutIdentity(first);
  return identity !== null && identity === checkoutIdentity(second);
}
