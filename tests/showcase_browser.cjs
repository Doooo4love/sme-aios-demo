const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(
  require.resolve("playwright", { paths: [__dirname, path.dirname(process.execPath)] }),
);

// Point this at an isolated demo database so the first alias really is new.
const baseURL = process.env.AIOS_DEMO_URL || "http://127.0.0.1:8761";
const captureDir = process.env.AIOS_CAPTURE_DIR;
if (captureDir) fs.mkdirSync(captureDir, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_BIN || undefined,
    channel: !process.env.CHROMIUM_BIN && process.platform === "win32" ? "chrome" : undefined,
  });
  const failures = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(20000);
    page.on("pageerror", (err) => failures.push(String(err)));
    page.on("console", (m) => { if (m.type() === "error") failures.push(m.text()); });
    const checkLayout = async (label) => {
      assert.ok(await page.evaluate(() => {
        const shell = document.querySelector(".app-shell");
        return document.documentElement.scrollWidth <= innerWidth + 1 && shell.scrollWidth <= shell.clientWidth + 1;
      }), label + " overflow");
    };
    const snap = async (...names) => {
      if (!captureDir) return;
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const png = await page.screenshot();
      for (const name of names) fs.writeFileSync(path.join(captureDir, name + ".png"), png);
    };
    await page.goto(baseURL);
    await page.locator("#welcome[open]").waitFor();
    await checkLayout("desktop welcome");
    await snap("welcome");
    await page.locator("#start-tour").click();

    async function select(sample, readShot) {
      assert.equal(await page.locator("[data-sample]").count(), 3);
      await page.locator(`[data-sample="${sample}"]`).click();
      await page.locator("#bbox").waitFor();
      assert.equal(await page.locator("#stepper .step").count(), 3);
      assert.equal(await page.locator(".header-fields .field").count(), 5);
      assert.equal(await page.locator(".item-group").count(), 2);
      assert.equal(await page.locator(".item-group").first().locator(".field").count(), 5);
      assert.equal(await page.locator(".item-group").last().locator(".field").count(), 5);
      await checkLayout(sample + " read");
      for (const key of ["buyer", "line.2.amount", "line.1.quantity"]) {
        await page.locator(`[data-field="${key}"]`).click();
        assert.match(await page.locator("#active-caption").textContent(), /Buyer|Line/);
      }
      await page.evaluate(() => document.querySelector(".app-shell").scrollTo(0, 0));
      await page.waitForTimeout(320);
      const geometry = await page.evaluate(() => {
        const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
        const hole = document.querySelector("#spot-hole"), grid = rect(".source-grid");
        const box = rect("#bbox"), img = rect(".paper img"), paper = rect(".paper");
        return {
          lit: +hole.getAttribute("x") <= grid.left && +hole.getAttribute("y") <= grid.top &&
            +hole.getAttribute("width") >= grid.width && +hole.getAttribute("height") >= grid.height,
          separate: rect("#coach").top >= rect(".app-shell").bottom - 1 && rect("#to-review").bottom <= innerHeight,
          aligned: Math.abs(img.width - paper.width) < 1 && Math.abs(img.height - paper.height) < 1,
          located: box.width > 0 && box.height > 0 && box.left >= img.left && box.right <= img.right + 1,
        };
      });
      assert.deepEqual(geometry, { lit: true, separate: true, aligned: true, located: true }, sample + " evidence geometry");
      assert.match(await page.locator("#coach-text").textContent(), /more fields.*Continue to review/);
      if (readShot) await snap(readShot);
      await page.locator("#to-review").click();
      await page.locator("#pipeline").waitFor();
      assert.equal(await page.locator("#spotlight").isVisible(), false);
      await checkLayout(sample + " review");
    }

    async function finish(shots = []) {
      const calls = [];
      const onRequest = (req) => {
        if (req.method() === "POST") calls.push(new URL(req.url()).pathname);
      };
      page.on("request", onRequest);
      await page.locator("#to-write:enabled").click();
      await page.getByRole("heading", { name: /SO-\d+ verified in ERP · 0 duplicates/ }).waitFor();
      page.off("request", onRequest);
      assert.equal(calls.filter((p) => p === "/api/approve").length, 1);
      const receipt = JSON.parse(await page.locator("#audit-data").textContent());
      assert.ok(receipt.events.some((event) => event.event === "OUTCOME_UNKNOWN"));
      assert.equal(await page.locator(".draft tbody tr").count(), 2);
      assert.equal(await page.locator("#coach").isVisible(), false);
      assert.equal(await page.locator("#payback,.business,.flow").count(), 0);
      await checkLayout("approved");
      if (shots.length) await snap(...shots);
      const number = (await page.locator(".page-head h1").textContent()).split(" ")[0];
      await page.locator("#restart").click();
      return { number, ticks: calls.filter((p) => p === "/api/worker/tick").length };
    }

    await select("review", "step1");
    assert.match(await page.locator("#pipeline").textContent(), /14 passed.*1 conflict/);
    assert.equal(await page.locator('[data-choice="8"]').count(), 0);
    assert.equal(await page.locator("#to-write").isDisabled(), true);
    assert.match(await page.locator(".amount-issue").textContent(), /Initial reading \(8\).*1,920 vs HK\$ 480/);
    await page.waitForFunction(() => document.querySelector(".crop").getContext("2d").getImageData(0,0,1,1).data[3] > 0);
    await snap("step2", "blocked");
    await page.getByRole("button", { name: "Confirm 2" }).click();
    await page.locator("#feedback.good").waitFor();
    assert.match(await page.locator("#feedback").textContent(), /2 cases → 48 pieces \(HK\$ 480\)/);
    assert.match(await page.locator(".amount-issue .badge").textContent(), /Confirmed/);
    assert.match(await page.locator("#pipeline").textContent(), /15 passed.*0 conflicts/);
    await snap("step2-confirmed");
    assert.equal((await finish(["step3", "receipt", "results"])).ticks, 2);

    await select("shorthand", "step1-forward");
    assert.equal(await page.locator(".candidate").count(), 3);
    await snap("step2-alias");
    await page.locator('[data-sku="SKU-1055"]').click();
    await page.locator("#to-write:enabled").waitFor();
    await page.locator("#remember").check();
    await page.waitForFunction(() => document.querySelector("#feedback")?.textContent.includes("catalogue"));
    const first = await finish();
    await select("shorthand");
    assert.match(await page.locator("#pipeline").textContent(), /1 matched from memory/);
    const reused = await finish();
    assert.equal(first.number, reused.number);
    assert.equal(reused.ticks, 0);
    await select("standard", "step1-printed");
    assert.equal(await page.locator(".issue").count(), 0);
    await finish();

    await page.setViewportSize({ width: 390, height: 844 });
    await checkLayout("mobile picker");
    await snap("mobile-picker");
    await select("review", "mobile-step1");
    await snap("mobile-step2");
    await page.locator("[data-input]").fill("2");
    await page.locator("#to-write:enabled").waitFor();
    await finish(["mobile-step3"]);
    await page.locator("#mode-open").click();
    await checkLayout("mobile welcome");
    await snap("mobile-welcome");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#start-explore").click();
    await page.locator("#file").setInputFiles(path.join(__dirname, "..", "fixtures", "harbour-shorthand.png"));
    await page.locator("#upload-form button.primary").click();
    await page.locator("#to-review").waitFor();
    await checkLayout("mobile upload fields");
    assert.equal(await page.locator("#spot-hole").evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
    await page.locator("#to-review").click();
    await page.locator("#to-write:enabled").waitFor();
    assert.match(await page.locator("#pipeline").textContent(), /1 matched from memory/);
    await checkLayout("mobile upload review");
    await snap("mobile-review");
    const upload = await finish();
    assert.equal(upload.number, first.number);
    assert.equal(upload.ticks, 0);
    await page.locator(".recent-panel summary").click();
    await page.locator("[data-run]").first().click();
    await page.getByRole("heading", { name: upload.number + " verified in ERP · 0 duplicates" }).waitFor();
    await checkLayout("mobile reopened order");
    console.log(JSON.stringify({ flows: ["B automatic block and confirmation", "C save and reuse mapping",
      "A straight through", "mobile B manual confirmation", "mobile upload, verified replay and reopen"], failures }, null, 2));
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
