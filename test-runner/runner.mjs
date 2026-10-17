import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const showcaseMode = args.includes("--showcase");
const rootDir = process.env.WORKSPACE_DIR || "/workspace";
const artifactsDir = process.env.ARTIFACTS_DIR || "/artifacts";
const galleryDir = path.join(artifactsDir, "gallery");

fs.mkdirSync(galleryDir, { recursive: true });

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const htmlDir = path.join(rootDir, "html");

const server = http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.join(htmlDir, safePath);

  if (!filePath.startsWith(htmlDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

server.listen(4173, "127.0.0.1", async () => {
  console.log("Static server running on http://127.0.0.1:4173");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: {
      dir: artifactsDir,
      size: { width: 1280, height: 720 },
    },
  });

  const page = await context.newPage();

  try {
    console.log("Navigating to http://127.0.0.1:4173/");
    await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });

    // 1. Wait for #title-btn-new-game to be visible
    try {
      await page.waitForSelector("#title-btn-new-game", { timeout: 5000 });
    } catch {
      // If splash overlay exists, click it
      const splash = await page.$("#splash-overlay");
      if (splash) {
        await splash.click();
      }
    }
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(galleryDir, "01-title-screen.png") });
    await page.screenshot({ path: path.join(artifactsDir, "01-title-screen.png") });

    // 2. Click #title-btn-guide
    const guideBtn = await page.$("#title-btn-guide");
    if (guideBtn) {
      await guideBtn.click();
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(galleryDir, "02-survival-guide.png") });
      await page.screenshot({ path: path.join(artifactsDir, "02-survival-guide.png") });
      const closeGuide = await page.$("#btn-close-guide, .close-guide, #guide-close");
      if (closeGuide) {
        await closeGuide.click();
      } else {
        await page.keyboard.press("Escape");
      }
      await page.waitForTimeout(500);
    }

    // 3. Click #title-btn-new-game -> Save Slot modal
    const newGameBtn = await page.$("#title-btn-new-game");
    if (newGameBtn) {
      await newGameBtn.click();
      await page.waitForTimeout(1200);
      const slotBtn = await page.$("[data-default-new='true'], .save-slot-card, .slot-btn");
      if (slotBtn) {
        await slotBtn.click();
      }
    }

    // 4. Wait for vocation selection
    try {
      await page.waitForSelector(".vocation-card[data-vocation='paladin'], .vocation-card", { timeout: 5000 });
    } catch {}
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(galleryDir, "03-choose-vocation.png") });
    await page.screenshot({ path: path.join(artifactsDir, "03-choose-vocation.png") });

    const selectMagician = await page.$(".select-btn[data-vocation='magician'], .vocation-card[data-vocation='magician'] button, .vocation-card button");
    if (selectMagician) {
      await selectMagician.click();
    }

    // 5. Fate Grant modal or dialogue
    await page.waitForTimeout(1600);
    const fateCard = await page.$(".fate-card");
    if (fateCard) {
      await page.screenshot({ path: path.join(galleryDir, "04-fate-grant-draft.png") });
      await page.screenshot({ path: path.join(artifactsDir, "04-fate-grant-draft.png") });
      const cards = await page.$$(".fate-card");
      if (cards.length >= 2) {
        await cards[0].click().catch(() => {});
        await page.waitForTimeout(300);
        await cards[1].click().catch(() => {});
      }
    } else {
      await page.screenshot({ path: path.join(galleryDir, "04-fate-grant-draft.png") });
      await page.screenshot({ path: path.join(artifactsDir, "04-fate-grant-draft.png") });
    }

    await page.waitForTimeout(1500);

    // 6. Havenreach & Overworld / Combat
    await page.screenshot({ path: path.join(galleryDir, "05-havenreach-and-overworld.png") });
    await page.screenshot({ path: path.join(artifactsDir, "05-havenreach-and-overworld.png") });

    // Try entering tower if available
    const townTower = await page.$("#town-tower, #btn-enter-tower, .tower-btn");
    if (townTower) {
      await townTower.click().catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Walk around & cast abilities
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(400);
      await page.keyboard.press("Digit1");
      await page.waitForTimeout(400);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(400);
      await page.keyboard.press("KeyQ");
      await page.waitForTimeout(400);
    }

    await page.screenshot({ path: path.join(galleryDir, "06-tower-combat-and-hud.png") });
    await page.screenshot({ path: path.join(artifactsDir, "06-tower-combat-and-hud.png") });

    // Ensure total showcase duration is ~30.5s
    await page.waitForTimeout(8000);

  } catch (err) {
    console.error("Showcase error:", err);
  } finally {
    await context.close();
    await browser.close();
    server.close();

    // Rename recorded video to demo.webm
    try {
      const files = fs.readdirSync(artifactsDir);
      const videoFile = files.find(f => f.endsWith(".webm") && f !== "demo.webm");
      if (videoFile) {
        fs.copyFileSync(path.join(artifactsDir, videoFile), path.join(artifactsDir, "demo.webm"));
        console.log("Saved video to /artifacts/demo.webm");
      }
    } catch (e) {
      console.error("Error renaming video:", e);
    }

    process.exit(0);
  }
});
