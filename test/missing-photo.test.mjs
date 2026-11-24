// A photo the report lists but the device cannot show. Run with: npm test
// Booted from disk, as the offline copy and a signed-out inspector use it.
// AHS_APP points the same test at another copy of the app (the offline file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const APP = process.env.AHS_APP || path.join(here, '..', 'public', 'index.html');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));

test('a photo that cannot be shown says which photo it is, and can be put back in the same place', { skip: !CHROME && 'Chrome not found' }, async () => {
  // 2026-11-24: nineteen red boxes all reading "Photo could not be read on
  // this device" - "i have no way of knowing what pictures are what so i cant
  // even up load them myself". In the order it happens: a report whose photo
  // list is intact but whose pictures are not on the device is opened; the
  // box names the photo; the picture is added back; the report is reloaded.
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.slice(0, 200)));
  page.on('dialog', d => d.accept());
  let first, box, after, kept;
  try {
    await page.goto(url.pathToFileURL(APP).href, { waitUntil: 'load', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    first = await page.evaluate(() => document.querySelectorAll('#imgp .img-item').length);
    // two photos in the report: one present, one whose picture is gone
    box = await page.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 200; c.height = 150;
      c.getContext('2d').fillRect(0, 0, 200, 150);
      const here = 'img-quick-1795524065871-here123', gone = 'img-cap-1795522359397-gone12345';
      await window.AHS_PHOTOS.put(here, c.toDataURL('image/jpeg', 0.8));
      allImages.push({ id: here, file: null, dataUrl: null, caption: 'Fire exit sign', link: null });
      allImages.push({ id: gone, file: null, dataUrl: null, caption: '2 x Genie lifts on site', link: null });
      await renderImages();
      const b = document.querySelector('#imgp .img-missing');
      return { tiles: document.querySelectorAll('#imgp .img-item img').length, boxes: document.querySelectorAll('#imgp .img-missing').length,
               text: b ? b.innerText : '', id: b && b.getAttribute('data-image-id'), remove: !!(b && b.querySelector('.img-remove-x')),
               draft: (await window.AHS_DRAFT.collect()).images.map(i => i.id) };
    });
    // put it back through the box's own file chooser
    const tmp = path.join(here, '..', 'node_modules', '.missing-photo-test.png');
    fs.writeFileSync(tmp, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP8z4APMOGVHbHSAEEsAROxCnMTAAAAAElFTkSuQmCC', 'base64'));
    try {
      await (await page.$('#imgp .img-missing input[type=file]')).uploadFile(tmp);
      await page.waitForFunction(() => document.querySelectorAll('#imgp .img-item img').length === 2 && !document.querySelector('#imgp .img-missing'), { timeout: 15000 });
    } finally { fs.rmSync(tmp, { force: true }); }
    after = await page.evaluate(async () => {
      const i = allImages.find(x => x.id === 'img-cap-1795522359397-gone12345');
      return { caption: i.caption, stored: !!(await window.AHS_PHOTOS.get(i.id)), order: allImages.map(x => x.id) };
    });
    kept = await page.evaluate(async () => (await window.AHS_DRAFT.collect()).images.map(i => [i.id, i.caption]));
  } finally {
    await browser.close();
  }
  assert.equal(first, 0, 'a new report did not start empty');
  assert.deepEqual([box.tiles, box.boxes], [1, 1], 'the photo that is present must show, and the one that is not must hold its place');
  assert.deepEqual(box.draft, ['img-quick-1795524065871-here123', 'img-cap-1795522359397-gone12345'], 'a photo that cannot be shown was dropped from the report');
  assert.match(box.text, /PHOTO 2 OF 2 IS NOT ON THIS DEVICE/i, 'the box does not say which photo it is');
  assert.match(box.text, /Caption: 2 x Genie lifts on site/, 'the box does not show the caption');
  assert.match(box.text, /Taken: 24 Nov 2026, \d\d:\d\d/, 'the box does not say when the photo was taken');
  assert.match(box.text, /Add this photo/, 'the box offers no way to put the photo back');
  assert.ok(box.remove, 'a box that cannot be filled cannot be removed either');
  assert.deepEqual(after, { caption: '2 x Genie lifts on site', stored: true, order: box.draft }, 'the photo added back lost its caption, its place, or was not stored');
  assert.deepEqual(kept, [['img-quick-1795524065871-here123', 'Fire exit sign'], ['img-cap-1795522359397-gone12345', '2 x Genie lifts on site']]);
  assert.deepEqual(errs, []);
});
