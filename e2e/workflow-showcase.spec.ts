import { expect, test } from './support/coverage-fixture';

test.describe('Flowstarter workflow showcase', () => {
  test('presents every recorded scenario and loads each clip', async ({ page }) => {
    await page.goto('/workflow-showcase');

    await expect(page).toHaveTitle(/How Flowstarter works/);
    await expect(
      page.getByRole('heading', { level: 1, name: /Flowstarter, actually running/i }),
    ).toBeVisible();
    await expect(page.getByText('No simulated workflow screens')).toBeVisible();
    await expect(page.locator('.wf-film')).toHaveCount(6);

    const videos = page.locator('.wf-film video');
    await expect(videos).toHaveCount(6);

    for (let index = 0; index < 4; index += 1) {
      const video = videos.nth(index);
      await expect.poll(() => video.evaluate((element: HTMLVideoElement) => ({
        duration: element.duration,
        error: element.error?.code ?? null,
        readyState: element.readyState,
      }))).toMatchObject({ error: null, readyState: 4 });
      expect(await video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(5);
    }
  });

  test('serves only the four genuine recordings, with no simulated stage', async ({ page }) => {
    await page.goto('/workflow-showcase');

    await expect(page.locator('.wf-film video')).toHaveCount(6);
    await expect(page.locator('.wf-live-frame')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Run the scenario live/i })).toHaveCount(0);
    await expect(page.locator('source[src^="/workflow-clips/"]')).toHaveCount(6);
  });

  test('fits a phone viewport without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto('/workflow-showcase');

    await expect(page.locator('.wf-film')).toHaveCount(6);
    await expect(page.locator('.wf-film video')).toHaveCount(6);

    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  });
});
