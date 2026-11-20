from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from aios_platform.assurance_catalog import compile_catalog, csv_headers, openapi_resources, reflect_resources


class CatalogTests(unittest.TestCase):
    def test_read_only_metadata_draft_ignores_business_rows(self):
        with TemporaryDirectory() as folder:
            database = Path(folder) / "source.sqlite"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE source_po (id INTEGER, account TEXT)")
                connection.execute("INSERT INTO source_po VALUES (1, 'business-record-hidden')")
            resources = reflect_resources(f"sqlite:///{database}", ["source_po"], None)
            draft = compile_catalog("procurement", resources)
            self.assertFalse(draft["executable"])
            self.assertEqual(draft["status"], "review_required")
            self.assertEqual(draft["resources"][0]["fields"][1]["classification"], "unclassified")
            self.assertNotIn("business-record-hidden", str(draft))
            with self.assertRaises(ValueError):
                reflect_resources(f"sqlite:///{database}", ["unapproved table; SELECT"], None)
            header = Path(folder) / "headers.csv"
            header.write_text("工厂,金额\nBusiness row,100\n", encoding="utf-8")
            self.assertEqual([field["name"] for field in csv_headers(header)[0]["fields"]], ["工厂", "金额"])

    def test_openapi_reference_and_server_urls_are_not_executed_or_exported(self):
        spec = {"openapi": "3.1.0", "servers": [{"url": "https://unused.example.test"}], "paths": {
            "/purchase": {"get": {"parameters": [{"name": "site"}, {"$ref": "https://unused.example.test/ref"}]}}
        }}
        draft = compile_catalog("procurement", openapi_resources(spec))
        self.assertNotIn("unused.example", str(draft))
        self.assertFalse(draft["resources"][0]["fields"][0]["model_visible"])
