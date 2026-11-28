import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function verifySourceRemoval(page,sourceUrl) {
  const shelf=page.getByRole('navigation',{name:'Library documents'});
  const row=title=>shelf.locator('.library-item').filter({hasText:title});
  const title=name=>page.locator('.library-document-header').getByRole('heading',{name,exact:true});
  const dialog=page.getByRole('dialog');
  const confirm=dialog.getByRole('button',{name:'Remove source'});
  const toggle=page.getByRole('button',{name:'Your documents'});
  await page.reload();
  await title('Field report').waitFor();
  const firstAddress=page.url();

  await row('Notebook').click({button:'right'});
  await page.getByRole('dialog',{name:/Remove “Notebook”/}).waitFor();
  assert.equal(page.url(),firstAddress);
  assert.equal(await dialog.getByRole('button',{name:'Cancel'}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  assert.equal(await row('Notebook').evaluate(node=>node===document.activeElement),true);

  await page.setViewportSize({width:390,height:844});
  await toggle.tap();
  const touch=await page.context().newCDPSession(page);
  async function touchStart() {
    const bounds=await row('Notebook').boundingBox();
    const point={x:Math.round(bounds.x+bounds.width/2),y:Math.round(bounds.y+bounds.height/2)};
    await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
    return point;
  }
  async function touchEnd() {
    await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  }
  const point=await touchStart();
  await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x,y:point.y-30}]});
  await delay(700);
  await touchEnd();
  assert.equal(await dialog.count(),0);
  assert.equal(page.url(),firstAddress);

  await row('Notebook').tap();
  await title('Notebook').waitFor();
  const notebookAddress=page.url();
  await toggle.tap();
  await touchStart();
  await dialog.waitFor();
  await touchEnd();
  await confirm.waitFor();
  assert.equal(page.url(),notebookAddress);

  // Fail one delete to exercise retry using the same confirmation.
  const endpoint='**/rest/v1/wc_library?*';
  const failOnce=async route=>{
    if (route.request().method()!=='DELETE') return route.fallback();
    await route.fulfill({status:503,json:{message:'Temporarily unavailable'}});
  };
  await page.route(endpoint,failOnce);
  await confirm.tap();
  await dialog.getByRole('alert').filter({hasText:'Temporarily unavailable'}).waitFor();
  await page.unroute(endpoint,failOnce);
  await confirm.tap();
  await title('Appendix').waitFor();
  assert.equal(await row('Notebook').count(),0);
  assert.equal(await toggle.getAttribute('aria-expanded'),'true');
  const lastAddress=page.url();

  await page.setViewportSize({width:1440,height:960});
  await row('Field report').focus();
  await page.keyboard.press('Shift+F10');
  await confirm.click();
  await row('Field report').waitFor({state:'detached'});
  assert.equal(page.url(),lastAddress);
  await title('Appendix').waitFor();

  await shelf.getByRole('button',{name:'Remove Appendix from library'}).press('Enter');
  await confirm.press('Enter');
  await page.getByText('Imported documents will appear here.').waitFor();
  assert.equal(new URL(page.url()).search,'');
  assert.equal(await page.locator('.library-document-header').count(),0);
  assert.equal(await page.getByLabel('Import a link').evaluate(node=>node===document.activeElement),true);
  await page.reload();
  await page.getByText('Imported documents will appear here.').waitFor();

  await page.getByLabel('Import a link').fill(sourceUrl);
  await page.getByRole('button',{name:'Import',exact:true}).click();
  await page.getByText('Checked in the saved layout.').waitFor();
  assert.equal(page.url(),firstAddress);
  await touch.detach();
}
