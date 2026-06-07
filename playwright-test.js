const { chromium } = require('playwright');

(async () => {
  console.log('Starting Playwright test...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  const context = await browser.newContext({
    permissions: ['microphone']
  });

  // Seed a dummy key so the app doesn't open the Settings prompt and blocks the mic.
  await context.addInitScript(() => {
    localStorage.setItem('openai_api_key', 'sk-test-dummy-key');
  });

  const page = await context.newPage();
  
  console.log('Navigating to http://localhost:3000...');
  await page.goto('http://localhost:3000');
  
  const headerText = await page.locator('h1').innerText();
  console.log(`Header found: "${headerText}"`);
  if (!headerText.includes('VoiceTodo Agent')) {
    throw new Error('Header does not match!');
  }
  console.log('Adding a manual task...');
  await page.fill('input[placeholder="Type a task manually..."]', 'Playwright automated test');
  await page.click('button:has-text("Add Task")');
  
  await page.waitForTimeout(1000);
  const taskText = await page.locator('text=Playwright automated test').innerText();
  console.log(`Verified added task: "${taskText}"`);
  
  console.log('Testing Microphone button...');
  const micButton = page.locator('button.h-24.w-24');
  await micButton.click();
  await page.waitForTimeout(500);
  const statusText = await page.locator('p.font-medium').innerText();
  console.log(`Recording status is: "${statusText}"`);
  
  if (!statusText.includes('Recording Audio')) {
    throw new Error('Microphone recording state did not trigger!');
  }
  
  await micButton.click();
  await page.waitForTimeout(1000);
  
  console.log('Test passed successfully!');
  await browser.close();
  process.exit(0);
})().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
