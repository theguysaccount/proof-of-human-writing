"""Build tests: python3 -m unittest discover -s tests -v

Builds the site into temporary folders (with today's date) and checks the output: every page and
link resolves, the security policy is on every page, the optional settings switch what they should.
Nothing here depends on launch-day content or counts.
"""
import importlib.util
import json
import os
import re
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build", ROOT / "pipeline" / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class Refs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs, self.ld, self._in_ld, self.csp, self.canonical = [], [], False, None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for key in ("href", "src"):
            if a.get(key):
                self.refs.append(a[key])
        if tag == "script" and a.get("type") == "application/ld+json":
            self._in_ld = True
        if tag == "meta" and a.get("http-equiv") == "Content-Security-Policy":
            self.csp = a.get("content")
        if tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href")

    def handle_endtag(self, tag):
        self._in_ld = False

    def handle_data(self, data):
        if self._in_ld:
            self.ld.append(data)


def make(env=None):
    out = Path(tempfile.mkdtemp())
    with mock.patch.dict(os.environ, env or {}, clear=False):
        for k in ("SITE_URL", "GOATCOUNTER_URL", "SCHOOLS_URL"):
            if k not in (env or {}):
                os.environ.pop(k, None)
        site = build.Site(out, build.dt.date.today()).build()
    return site, out


class BuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site, cls.out = make()

    def pages(self):
        return sorted(self.out.rglob("*.html"))

    def test_every_page_is_built_and_in_the_sitemap(self):
        sitemap = (self.out / "sitemap.xml").read_text()
        locs = re.findall(r"<loc>([^<]+)</loc>", sitemap)
        self.assertEqual(len(locs), len(self.site.indexable))
        for path in self.site.indexable:
            self.assertTrue((self.out / (path + "index.html")).exists(), path)
            self.assertIn(f"{build.DEFAULT_SITE_URL}/{path}", locs)
        self.assertNotIn("404", sitemap)
        self.assertIn(f"Sitemap: {build.DEFAULT_SITE_URL}/sitemap.xml", (self.out / "robots.txt").read_text())
        self.assertEqual((self.out / f"{build.INDEXNOW_KEY}.txt").read_text(), build.INDEXNOW_KEY)
        self.assertEqual((self.out / "urls.txt").read_text().split(), [f"{build.DEFAULT_SITE_URL}/{p}" for p in self.site.indexable])

    def test_every_local_link_and_file_resolves(self):
        for page in self.pages():
            refs = Refs()
            refs.feed(page.read_text())
            for ref in refs.refs:
                if re.match(r"^(https?:|mailto:|#|data:)", ref) or ref.startswith("/proof-of-human-writing/"):
                    continue
                target = (page.parent / ref.split("#")[0].split("?")[0]).resolve()
                if ref.split("#")[0].split("?")[0].endswith("/") or target.is_dir():
                    target = target / "index.html"
                self.assertTrue(target.exists(), f"{page.relative_to(self.out)} links to missing {ref}")

    def test_every_page_has_the_security_policy_metadata_and_no_placeholders(self):
        for page in self.pages():
            html = page.read_text()
            refs = Refs()
            refs.feed(html)
            self.assertIn("connect-src 'none'", refs.csp, page)
            self.assertIn("script-src 'self';", refs.csp, page)
            self.assertNotIn("{{", html, page)
            self.assertIn('<meta name="description"', html, page)
            self.assertIn('property="og:image"', html, page)
            for block in refs.ld:
                json.loads(block)
            rel = page.relative_to(self.out).as_posix()
            if rel != "404.html":
                self.assertEqual(refs.canonical, f"{build.DEFAULT_SITE_URL}/{rel[:-len('index.html')]}", page)

    def test_the_format_page_quotes_the_numbers_the_code_uses(self):
        core = (ROOT / "site" / "assets" / "core.js").read_text()
        idle = int(re.search(r"idleMs: ([\d_]+)", core).group(1).replace("_", "")) // 1000
        html = (self.out / "format" / "index.html").read_text()
        self.assertIn(f"longer than {idle} seconds", html)
        self.assertIn("version " + re.search(r"export const VERSION = (\d+)", core).group(1), html)

    def test_the_sample_replay_is_valid_and_complete(self):
        sample = json.loads((self.out / "assets" / "sample.writing-replay.json").read_text())
        self.assertEqual(sample["format"], "writing-replay")
        self.assertTrue(sample["sessions"])
        module = (self.out / "assets" / "sample-replay.js").read_text()
        self.assertIn("export default", module)

    def test_imports_carry_the_build_version(self):
        for js in (self.out / "assets").glob("*.js"):
            for m in re.findall(r'from\s+"(\./[^"]+)"', js.read_text()):
                self.assertIn(f"?v={self.site.ver}", m, js.name)

    def test_optional_keys_switch_what_they_should(self):
        site, out = make({"GOATCOUNTER_URL": "https://example.goatcounter.com/count", "SCHOOLS_URL": "https://example.org/schools",
                          "SITE_URL": "https://writing.example.org"})
        home = (out / "index.html").read_text()
        self.assertIn("https://gc.zgo.at", home)
        self.assertIn("connect-src https://example.goatcounter.com", home)
        self.assertIn("GoatCounter", home)
        self.assertIn("https://example.org/schools", home)
        self.assertIn('<link rel="canonical" href="https://writing.example.org/">', home)
        self.assertIn("Sitemap: https://writing.example.org/sitemap.xml", (out / "robots.txt").read_text())
        self.assertIn('href="/assets/site.css', (out / "404.html").read_text())
        # Off by default: no analytics script, no money slot.
        default_home = (self.out / "index.html").read_text()
        self.assertNotIn("gc.zgo.at", default_home)
        self.assertNotIn("For schools and publications", default_home)
        self.assertIn('href="/proof-of-human-writing/assets/site.css', (self.out / "404.html").read_text())


if __name__ == "__main__":
    unittest.main()
