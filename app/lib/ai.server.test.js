import { describe, it, expect } from "vitest";
import {
  sanitizeGeneratedText,
  htmlToText,
  truncateAtWordBoundary,
} from "./ai.server.js";

describe("sanitizeGeneratedText", () => {
  it("returns clean text untouched", () => {
    expect(sanitizeGeneratedText("Vintage Denim Jacket")).toBe(
      "Vintage Denim Jacket",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeGeneratedText("  padded  ")).toBe("padded");
  });

  it("coerces null / undefined to an empty string", () => {
    expect(sanitizeGeneratedText(null)).toBe("");
    expect(sanitizeGeneratedText(undefined)).toBe("");
  });

  it("strips a 'Here's a title:' preamble", () => {
    expect(sanitizeGeneratedText("Here's a title: Vintage Lamp")).toBe(
      "Vintage Lamp",
    );
  });

  it("strips a 'Here is the description:' preamble", () => {
    expect(
      sanitizeGeneratedText("Here is the description: A nice thing"),
    ).toBe("A nice thing");
  });

  it("strips a bare 'Title:' / 'description:' label", () => {
    expect(sanitizeGeneratedText("Title: Vintage Lamp")).toBe("Vintage Lamp");
    expect(sanitizeGeneratedText("description: <p>hi</p>")).toBe("<p>hi</p>");
  });

  it("strips a compound preamble in multiple passes", () => {
    expect(
      sanitizeGeneratedText("Based on my research, here's a title: Retro Chair"),
    ).toBe("Retro Chair");
  });

  it("unwraps a fenced code block (with and without a language tag)", () => {
    expect(sanitizeGeneratedText("```html\n<p>Hello</p>\n```")).toBe(
      "<p>Hello</p>",
    );
    expect(sanitizeGeneratedText("```\nplain text\n```")).toBe("plain text");
  });

  it("strips wrapping quotes around a short answer", () => {
    expect(sanitizeGeneratedText('"Quoted Title"')).toBe("Quoted Title");
    expect(sanitizeGeneratedText("'Quoted Title'")).toBe("Quoted Title");
  });

  it("does not strip a colon that is part of the real content", () => {
    expect(
      sanitizeGeneratedText("Sony Walkman: The Classic Model"),
    ).toBe("Sony Walkman: The Classic Model");
  });

  it("only strips a preamble at the start, not mid-string", () => {
    expect(
      sanitizeGeneratedText("This jacket? Here's why it rocks"),
    ).toBe("This jacket? Here's why it rocks");
  });
});

describe("htmlToText", () => {
  it("returns an empty string for falsy input", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
  });

  it("drops tags and keeps the text of a single paragraph", () => {
    expect(htmlToText("<p>Hello</p>")).toBe("Hello");
  });

  it("turns paragraph breaks into newlines", () => {
    expect(htmlToText("<p>One</p><p>Two</p>")).toBe("One\nTwo");
  });

  it("turns <br> variants into newlines", () => {
    expect(htmlToText("Line1<br>Line2<br/>Line3<br />Line4")).toBe(
      "Line1\nLine2\nLine3\nLine4",
    );
  });

  it("strips inline formatting tags", () => {
    expect(
      htmlToText("<strong>Bold</strong> and <em>italic</em>"),
    ).toBe("Bold and italic");
  });

  it("decodes the handled HTML entities", () => {
    expect(htmlToText("&lt;tag&gt; &quot;q&quot; it&#39;s &amp; done")).toBe(
      "<tag> \"q\" it's & done",
    );
  });

  it("collapses runs of 3+ newlines down to a blank line", () => {
    expect(
      htmlToText("<div>A</div><div></div><div></div><div>B</div>"),
    ).toBe("A\n\nB");
  });
});

describe("truncateAtWordBoundary", () => {
  it("returns short text unchanged, with no ellipsis", () => {
    expect(truncateAtWordBoundary("hello world", 100)).toBe("hello world");
  });

  it("returns text of exactly maxChars unchanged", () => {
    expect(truncateAtWordBoundary("hello", 5)).toBe("hello");
  });

  it("collapses internal whitespace", () => {
    expect(truncateAtWordBoundary("a   b\n\nc", 100)).toBe("a b c");
  });

  it("cuts at the last word boundary before maxChars and appends an ellipsis", () => {
    expect(truncateAtWordBoundary("the quick brown fox jumps", 12)).toBe(
      "the quick…",
    );
  });

  it("cuts mid-word only when the first word already exceeds maxChars", () => {
    expect(truncateAtWordBoundary("supercalifragilistic", 5)).toBe("super…");
  });

  it("appends the single-character ellipsis, not three dots", () => {
    const out = truncateAtWordBoundary("one two three four", 9);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("...");
  });
});
