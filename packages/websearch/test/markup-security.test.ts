import { expect, it } from "vitest";
import { stripTags, stripTrailingSlashes } from "../src/engines/html.js";
import { parseMojeek } from "../src/engines/mojeek.js";

it("preserves unmatched markup and decodes entities after stripping tags", () => {
  expect(stripTags("before <unclosed")).toBe("before <unclosed");
  expect(stripTags("<b>&lt;literal&gt;</b>")).toBe("<literal>");
});

it("finds the exact class attribute after a data-class attribute", () => {
  const result = parseMojeek('<!--rs--><a data-class="tracking" class="title" href="https://example.test/">Title</a><!--re-->');
  expect(result).toEqual([{ title: "Title", url: "https://example.test/", snippet: "" }]);
});

it("skips an empty-href placeholder before a valid result title", () => {
  const result = parseMojeek('<!--rs--><a class="title" href="">placeholder</a><a class="title" href="https://example.test/">Title</a><!--re-->');
  expect(result).toEqual([{ title: "Title", url: "https://example.test/", snippet: "" }]);
});

it("handles repeated malformed tags and result markers without retrying suffixes", () => {
  const tags = "<".repeat(100_000);
  expect(stripTags(tags)).toBe(tags);
  expect(parseMojeek("<!--rs-->".repeat(100_000))).toEqual([]);
  expect(parseMojeek(`<!--rs-->${'<a class="title" href="x">'.repeat(10_000)}<!--re-->`)).toEqual([]);
  expect(stripTrailingSlashes(`https://example.test${"/".repeat(100_000)}`)).toBe("https://example.test");
  expect(stripTrailingSlashes(`/${"/".repeat(100_000)}x`).endsWith("x")).toBe(true);
}, 2000);
