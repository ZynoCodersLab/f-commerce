import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// The root layout points the browser at the manifest and the icon set. A wrong
// path is invisible in the unit suite and shows up as a 404 in the browser, so
// fetch every asset the metadata names.

test('serves the manifest and icons named in the app metadata', async ({ page, request }) => {
  await page.goto('/login');

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref, 'the layout should link a web manifest').toBeTruthy();
  if (!manifestHref) return;

  const manifest = await request.get(manifestHref);
  expect(manifest.status(), `manifest ${manifestHref}`).toBe(200);

  // An empty name leaves the install prompt with no app title, so keep both
  // values real, not placeholders.
  const manifestBody = (await manifest.json()) as { name?: string; short_name?: string };
  expect(manifestBody.name?.trim(), 'manifest name').toBeTruthy();
  expect(manifestBody.short_name?.trim(), 'manifest short_name').toBeTruthy();

  const iconHrefs = await page
    .locator('link[rel="icon"], link[rel="apple-touch-icon"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
  expect(iconHrefs.length).toBeGreaterThan(0);

  for (const href of iconHrefs) {
    if (!href) continue;
    const icon = await request.get(href);
    expect(icon.status(), `icon ${href}`).toBe(200);
  }

  // An `app/favicon.ico` file shadows `public/favicon.ico` at the same URL, so
  // the tab can show the scaffold icon even though every request returns 200.
  // Compare the bytes to catch a shadowed or replaced favicon.
  const favicon = await request.get('/favicon.ico');
  const intended = await readFile(join(__dirname, '..', 'public', 'favicon.ico'));
  expect(
    Buffer.from(await favicon.body()).equals(intended),
    'served /favicon.ico is public/favicon.ico',
  ).toBe(true);
});
