import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [oldRoot,newRoot,fixture,output]=process.argv.slice(2);
assert.ok(oldRoot && newRoot && fixture && output,'Pass old package, new source, fresh fixture, and output paths');
const moduleAt=(root,file)=>import(pathToFileURL(path.join(root,file)).href);
const oldApi=await moduleAt(oldRoot,'dist/src/index.js');
const newApi=await moduleAt(newRoot,'dist/src/index.js');
const oldPackage=JSON.parse(fs.readFileSync(path.join(oldRoot,'package.json'),'utf8'));
const newPackage=JSON.parse(fs.readFileSync(path.join(newRoot,'package.json'),'utf8'));
assert.equal(oldPackage.version,'2.7.1');
assert.equal(newPackage.version,'2.7.2');
for (const key of ['exports','bin','main','types','engines','dependencies','optionalDependencies','peerDependencies','peerDependenciesMeta']) {
  assert.deepEqual(newPackage[key],oldPackage[key],`Changed public package field: ${key}`);
}
assert.deepEqual(Object.keys(newApi).sort(),Object.keys(oldApi).sort(),'Public root exports changed');
function files(root) {
  return fs.readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()
    ? files(path.join(root,entry.name)).map(file=>path.join(entry.name,file)) : [entry.name]).sort();
}
const declarations=files(path.join(oldRoot,'types'));
assert.deepEqual(files(path.join(newRoot,'types')),declarations);
for (const file of declarations) {
  assert.equal(fs.readFileSync(path.join(newRoot,'types',file),'utf8').replaceAll('\r\n','\n'),fs.readFileSync(path.join(oldRoot,'types',file),'utf8').replaceAll('\r\n','\n'),`Public declaration changed: ${file}`);
}
console.log(`Public package contract, ${Object.keys(newApi).length} root exports, and ${declarations.length} declaration files match 2.7.1.`);
assert.ok(!fs.existsSync(fixture),'Use a fresh migration fixture');
fs.mkdirSync(fixture,{recursive:true});
const installationHome=path.join(fixture,'installation-home');
const profileHome=path.join(fixture,'profile-home');
const {installChromiumFork:installOld}=await moduleAt(oldRoot,'dist/src/chromium-fork-install.js');
const {installChromiumFork:installNew}=await moduleAt(newRoot,'dist/src/chromium-fork-install.js');
const runtime=await moduleAt(newRoot,'dist/src/chromium-fork.js');
const installedOld=await installOld({home:installationHome});
assert.equal(installedOld.alreadyInstalled,false);
process.env.BETTERWRIGHT_CHROMIUM_PATH=installedOld.binary;
const server=http.createServer((request,response)=>{
  if (request.url==='/seed') response.setHeader('set-cookie','migration=retained; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax');
  if (request.url==='/cookie-check') {
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify({authenticated:/(?:^|; )migration=retained(?:;|$)/.test(request.headers.cookie||'')}));
    return;
  }
  response.writeHead(200,{'content-type':'text/html'});
  response.end('<!doctype html><title>Upgrade fixture</title><input aria-label="Value"><button>Save</button>');
});
server.listen(0,'127.0.0.1');
await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
const options=Api=>({home:profileHome,profile:'retained-profile',headless:true,geoip:false,adBlock:false,vault:false,
  policy:new Api.NetworkPolicy({allowPrivateNetwork:false,allowLoopback:true,
    custom:url=>({allowed:new URL(url).hostname==='127.0.0.1',reason:'Migration fixture only'})})});
const oldBrowser=new oldApi.BetterWright(options(oldApi));
const oldVault=oldApi.createLocalCredentialVault({home:profileHome});
let newBrowser;
let newVault;
try {
  const seeded=await oldBrowser.run(`
    await page.goto(${JSON.stringify(origin+'/seed')});
    await page.getByRole('textbox',{name:'Value'}).fill('old-api-call');
    return page.evaluate(async()=>{
      localStorage.setItem('migration','local-retained');
      await new Promise((resolve,reject)=>{
        const request=indexedDB.open('migration-db',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('state');
        request.onerror=()=>reject(request.error);
        request.onsuccess=()=>{
          const db=request.result;
          const tx=db.transaction('state','readwrite');
          tx.objectStore('state').put('indexed-retained','migration');
          tx.oncomplete=()=>{db.close();resolve();}; tx.onerror=()=>reject(tx.error);
        };
      });
      return {ua:navigator.userAgent,value:document.querySelector('input').value};
    });`);
  assert.equal(seeded.ok,true,seeded.error);
  assert.equal(seeded.profileMode,'persistent');
  assert.match(seeded.result.ua,/Chrome\/151\./);
  assert.equal(seeded.result.value,'old-api-call');
  const saved=await oldVault.handleRequest('save',{username:'migration-fixture',password:'fixture-password-only'},origin);
  assert.ok(saved.id);
  await oldBrowser.close();
  oldVault.dispose();
  const seedPaths=files(profileHome).filter(file=>file.endsWith('.betterwright-fingerprint-seed'));
  assert.equal(seedPaths.length,1);
  const seedHash=createHash('sha256').update(fs.readFileSync(path.join(profileHome,seedPaths[0]))).digest('hex');
  assert.equal(runtime.chromiumForkInstallationMatches({root:installedOld.root}),false);
  const upgraded=await installNew({home:installationHome});
  assert.equal(upgraded.alreadyInstalled,false);
  assert.equal(upgraded.binary,installedOld.binary,'Upgrade changed the managed binary location');
  assert.equal(runtime.chromiumForkInstallationMatches({root:upgraded.root}),true);
  assert.equal(runtime.resolveChromiumForkBinary({home:installationHome,env:{}}),upgraded.binary);
  assert.equal((await installNew({home:installationHome})).alreadyInstalled,true);
  newBrowser=new newApi.BetterWright(options(newApi));
  const checked=await newBrowser.run(`
    await page.goto(${JSON.stringify(origin)});
    await page.getByRole('textbox',{name:'Value'}).fill('same-api-after-upgrade');
    return page.evaluate(async()=>{
      const indexed=await new Promise((resolve,reject)=>{
        const request=indexedDB.open('migration-db',1);
        request.onerror=()=>reject(request.error);
        request.onsuccess=()=>{
          const db=request.result;
          const tx=db.transaction('state','readonly');
          const read=tx.objectStore('state').get('migration');
          read.onsuccess=()=>resolve(read.result); read.onerror=()=>reject(read.error);
          tx.oncomplete=()=>db.close();
        };
      });
      return {ua:navigator.userAgent,local:localStorage.getItem('migration'),indexed,
        cookie:await fetch('/cookie-check').then(response=>response.json()),
        visibleCookies:document.cookie,value:document.querySelector('input').value};
    });`);
  assert.equal(checked.ok,true,checked.error);
  assert.equal(checked.profileMode,'persistent');
  assert.match(checked.result.ua,/Chrome\/153\./);
  assert.equal(checked.result.local,'local-retained');
  assert.equal(checked.result.indexed,'indexed-retained');
  assert.deepEqual(checked.result.cookie,{authenticated:true});
  assert.equal(checked.result.visibleCookies,'');
  assert.equal(checked.result.value,'same-api-after-upgrade');
  newVault=newApi.createLocalCredentialVault({home:profileHome});
  const revealed=await newVault.ownerReveal(saved.id);
  assert.equal(revealed.username,'migration-fixture');
  assert.equal(revealed.secret,'fixture-password-only');
  await newBrowser.close();
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(profileHome,seedPaths[0]))).digest('hex'),seedHash);
  const result={oldVersion:oldPackage.version,newVersion:newPackage.version,oldChromium:151,newChromium:153,
    publicExportsUnchanged:true,publicDeclarationsUnchanged:true,dependenciesUnchanged:true,
    sameManagedLocation:true,automaticReplacementWithoutForce:true,receiptAndDiscoveryVerified:true,
    persistentProfile:true,httpOnlyCookieRetained:true,localStorageRetained:true,indexedDbRetained:true,
    savedVaultCredentialRetained:true,fingerprintSeedRetained:true,sameSdkCallsAndOptions:true};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log('2.7.1 to 2.7.2 upgrade passed:',JSON.stringify(result));
} finally {
  await oldBrowser.close();
  await newBrowser?.close();
  oldVault.dispose();
  newVault?.dispose();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
