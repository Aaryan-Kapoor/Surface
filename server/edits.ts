// Text-based diff primitive for surface HTML.
//
// An Edit is a unique-anchor find/replace. It's deliberately simpler than
// `patch(1)` unified diffs — agents already know this shape from the
// str_replace/Edit tools, and it sidesteps line-number drift.
//
// Contract:
//   - `old_string` must match exactly once in the source; ambiguous edits fail.
//   - `old_string` must not equal `new_string`.
//   - Empty `old_string` is rejected (append/prepend get their own ops later).
//   - Edits are applied sequentially against the running buffer so later edits
//     see earlier edits' results.

export interface Edit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditResult {
  html: string;
  applied: number;
  replaced: number;
  summary: string;
}

export class EditError extends Error {
  constructor(
    message: string,
    public index: number,
    public code:
      | "not_found"
      | "ambiguous"
      | "identical"
      | "empty_old_string"
      | "bad_shape"
  ) {
    super(message);
    this.name = "EditError";
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function replaceAll(haystack: string, needle: string, replacement: string): { out: string; count: number } {
  let out = "";
  let count = 0;
  let i = 0;
  while (i <= haystack.length) {
    const hit = haystack.indexOf(needle, i);
    if (hit === -1) {
      out += haystack.slice(i);
      break;
    }
    out += haystack.slice(i, hit) + replacement;
    count++;
    i = hit + needle.length;
  }
  return { out, count };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export function applyEdits(source: string, edits: Edit[]): EditResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new EditError("edits must be a non-empty array", -1, "bad_shape");
  }
  let html = source;
  let replacedTotal = 0;
  const parts: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (!e || typeof e.old_string !== "string" || typeof e.new_string !== "string") {
      throw new EditError(`edit[${i}] must have string old_string and new_string`, i, "bad_shape");
    }
    if (e.old_string === "") {
      throw new EditError(`edit[${i}]: old_string must be non-empty`, i, "empty_old_string");
    }
    if (e.old_string === e.new_string) {
      throw new EditError(`edit[${i}]: old_string and new_string are identical`, i, "identical");
    }
    const count = countOccurrences(html, e.old_string);
    if (count === 0) {
      throw new EditError(
        `edit[${i}]: old_string not found. First 80 chars: ${JSON.stringify(truncate(e.old_string, 80))}`,
        i,
        "not_found"
      );
    }
    if (!e.replace_all && count > 1) {
      throw new EditError(
        `edit[${i}]: old_string matches ${count} times; pass replace_all=true or include more context to disambiguate`,
        i,
        "ambiguous"
      );
    }
    if (e.replace_all) {
      const r = replaceAll(html, e.old_string, e.new_string);
      html = r.out;
      replacedTotal += r.count;
      parts.push(`edit[${i}] x${r.count}: ${truncate(e.old_string, 40)} → ${truncate(e.new_string, 40)}`);
    } else {
      const at = html.indexOf(e.old_string);
      html = html.slice(0, at) + e.new_string + html.slice(at + e.old_string.length);
      replacedTotal += 1;
      parts.push(`edit[${i}]: ${truncate(e.old_string, 40)} → ${truncate(e.new_string, 40)}`);
    }
  }
  return {
    html,
    applied: edits.length,
    replaced: replacedTotal,
    summary: parts.join("\n"),
  };
}
