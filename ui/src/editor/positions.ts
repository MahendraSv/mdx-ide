// Rust reports UTF-8 byte offsets; CodeMirror positions are UTF-16 code units.

import type { Text } from "@codemirror/state";

export function byteOffsetToPos(doc: Text, byteOffset: number): number {
  let bytes = 0;
  let pos = 0;
  const iter = doc.iter();
  while (!iter.next().done) {
    const chunk = iter.value;
    for (let i = 0; i < chunk.length; i++) {
      if (bytes >= byteOffset) return pos;
      const code = chunk.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4; // surrogate pair = one 4-byte code point
        i++;
        pos++;
      } else bytes += 3;
      pos++;
    }
  }
  return Math.min(pos, doc.length);
}
