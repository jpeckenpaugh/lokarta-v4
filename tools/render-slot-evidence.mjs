#!/usr/bin/env node
// Evidence runner for the save-slot UX. Uses the preinstalled headless
// browser (see the "Tooling: headless browser is preinstalled" directive) and a
// running static server on :4173 (python3 -m http.server -d html 4173).
// No runtime installs: `require('playwright')` resolves from any cwd.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// Evidence is run-owned, not committed (docs/evidence PNGs are retired per
// agents.md §8: T2 browser evidence belongs to the board). Default to the
// gitignored tmp/ dir; override with EVIDENCE_DIR when needed.
const OUT = process.env.EVIDENCE_DIR || 'tmp/evidence';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const aria = async (selector) => (await page.locator(selector).ariaSnapshot()).trim();
const readSlots = () => page.evaluate(async () => {
  const db = await new Promise(res => { const r = indexedDB.open('lokarta_browser_db'); r.onsuccess = () => res(r.result); });
  const all = (store) => new Promise(res => { const t = db.transaction(store, 'readonly').objectStore(store).getAll(); t.onsuccess = () => res(t.result); });
  const slots = await all('save_slots');
  return slots.map(s => ({ slotIndex: s.slotIndex, status: s.status, vocation: s.vocation, level: s.level }));
});
const advancePastFateDraft = async () => {
  await page.waitForTimeout(2200);
  const cards = page.locator('.fate-card');
  if (await cards.count()) {
    // The Fate Grant screen auto-applies the draft once exactly two
    // cards are checked; there is no Confirm button to click.
    await cards.nth(0).click();
    await page.waitForTimeout(200);
    await cards.nth(1).click();
    await page.waitForTimeout(1100);
  }
};
const pauseAndReturnToTitle = async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  if (await page.locator('#pause-title').count()) {
    await page.locator('#pause-title').click();
    await page.waitForTimeout(1800);
  }
};

await page.goto('http://localhost:4173/index.html');
await page.waitForTimeout(2500);

console.log('== AC1: fresh profile, New Game -> first slot defaulted/auto-selected, no dead end ==');
await page.locator('#title-btn-new-game').click();
await page.waitForTimeout(900);
const fresh = await page.evaluate(() => {
  const def = document.querySelector('[data-default-new="true"]');
  return {
    defaultSlot: def?.dataset?.slot,
    defaultLabel: def?.textContent?.trim(),
    selectedCard: document.querySelector('.slot-card.empty.selected')?.dataset?.slot,
    primaryBtn: document.querySelector('.slot-new-btn.primary')?.textContent?.trim(),
    focusedLabel: document.activeElement?.textContent?.trim(),
    focusedIsInsideModal: !!document.querySelector('.slot-select-modal')?.contains(document.activeElement),
    emptySlotButtonsDisabled: Array.from(document.querySelectorAll('.slot-card.empty .slot-new-btn')).map(b => b.disabled),
    aria: null,
  };
});
fresh.aria = await aria('.slot-select-modal');
console.log(JSON.stringify(fresh, null, 2));
await page.screenshot({ path: `${OUT}/ac1-fresh-slot-default.png` });

// one step: focused default + Enter
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const reachedCharSelect = await page.locator('.character-select-modal').count();
console.log('AC1 reach character creation via focused default + Enter:', reachedCharSelect === 1);
await page.screenshot({ path: `${OUT}/ac1b-char-select.png` });

// create slot 1
await page.locator('.vocation-card[data-vocation="fighter"] .select-btn').click();
await advancePastFateDraft();
await pauseAndReturnToTitle();
console.log('slots after creating slot 1:', JSON.stringify(await readSlots()));

console.log('\n== default advances to first available slot once slot 1 is occupied ==');
await page.locator('#title-btn-new-game').click();
await page.waitForTimeout(900);
console.log(JSON.stringify(await page.evaluate(() => ({
  defaultSlot: document.querySelector('[data-default-new="true"]')?.dataset?.slot,
  defaultLabel: document.querySelector('[data-default-new="true"]')?.textContent?.trim(),
  focusedLabel: document.activeElement?.textContent?.trim(),
}))));
await page.screenshot({ path: `${OUT}/ac2-slot1-occupied-default-slot2.png` });
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
console.log('reached char select for slot 2:', (await page.locator('.character-select-modal').count()) === 1);
await page.locator('.vocation-card[data-vocation="magician"] .select-btn').click();
await advancePastFateDraft();
await pauseAndReturnToTitle();
console.log('slots after creating slot 2:', JSON.stringify(await readSlots()));

console.log('\n== AC2: delete an occupied slot in one obvious action (with confirm) ==');
await page.locator('#title-btn-new-game').click();
await page.waitForTimeout(900);
console.log('slot aria before delete:');
console.log(await aria('.slot-select-modal'));
await page.screenshot({ path: `${OUT}/ac2b-two-occupied.png` });
await page.locator('[data-action="delete"][data-slot="2"]').click();
await page.waitForTimeout(600);
const confirm = await page.evaluate(() => ({
  title: document.querySelector('#modal-overlay h2')?.textContent?.trim(),
  body: document.querySelector('#modal-overlay .result-subtitle')?.textContent?.trim(),
  safeFocus: document.activeElement?.id,
}));
console.log('delete confirm:', JSON.stringify(confirm));
await page.screenshot({ path: `${OUT}/ac2c-delete-confirm.png` });
await page.locator('#confirm-ok').click();
await page.waitForTimeout(1300);
console.log('slots after delete:', JSON.stringify(await readSlots()));
const afterDelete = await page.evaluate(() => ({
  slot2Empty: !!document.querySelector('.slot-card.empty[data-slot="2"]'),
  slot1Occupied: !!document.querySelector('.slot-card.occupied[data-slot="1"]'),
  defaultSlot: document.querySelector('[data-default-new="true"]')?.dataset?.slot,
}));
console.log('after delete UI:', JSON.stringify(afterDelete));
await page.screenshot({ path: `${OUT}/ac2d-after-delete.png` });

console.log('\n== AC3: immediately reuse the freed slot via New Game ==');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
console.log('reached char select for freed slot:', (await page.locator('.character-select-modal').count()) === 1);
await page.screenshot({ path: `${OUT}/ac3-freed-slot-reused.png` });
await page.locator('.vocation-card[data-vocation="paladin"] .select-btn').click();
await advancePastFateDraft();
await pauseAndReturnToTitle();
console.log('final slots:', JSON.stringify(await readSlots()));

console.log('\nPAGE ERRORS:', errors.length ? errors : 'none');
await browser.close();

