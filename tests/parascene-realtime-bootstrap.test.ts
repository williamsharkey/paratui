import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHostedRealtimeConfigFromHtml } from "../src/api.js";

test("parses injected parascene supabase config from html shell", () => {
  const html = `
    <html>
      <head>
        <script>window.__PRSN_SUPABASE__={"url":"https://abc.supabase.co","anonKey":"anon-test-key"};</script>
      </head>
    </html>
  `;

  assert.deepEqual(parseHostedRealtimeConfigFromHtml(html), {
    url: "https://abc.supabase.co",
    anonKey: "anon-test-key"
  });
});

test("returns null when supabase boot config is absent", () => {
  assert.equal(parseHostedRealtimeConfigFromHtml("<html></html>"), null);
});
